/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const {components, Ci, Cc, Cm, Cr, Cu} = require("chrome");
const {Class} = require("sdk/core/heritage");
const {data} = require("sdk/self");
const {Factory, Unknown} = require("sdk/platform/xpcom");
const {on, off} = require("sdk/system/events");
const {PageMod} = require("sdk/page-mod");
const Preferences = require("sdk/simple-prefs");
const privateBrowsing = require("sdk/private-browsing")
const {setTimeout} = require("sdk/timers");
const {storage} = require("sdk/simple-storage");
const unload = require("sdk/system/unload");
const {WindowTracker} = require("sdk/deprecated/window-utils");

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");

const AUTO_BLOCK_COOKIE = "cookie";
const AUTO_BLOCK_CONNECTION = "connection";
const CONNECTION_MULTIPLIER = 2;
const DEFAULT_AUTO_BLOCK_THRESHOLD = 5;
const RELOAD_AUTO_ACCEPT_DURATION = 10000;

// Keep track of all the sites being tracked by trackers
const allTracked = {};

exports.main = function() {
  // Initialize persistent data and defaults
  if (storage.autoBlockThreshold == null) {
    storage.autoBlockThreshold = DEFAULT_AUTO_BLOCK_THRESHOLD;
  }
  if (storage.blocked == null) {
    storage.blocked = {};
  }
  if (storage.trackers == null) {
    storage.trackers = {};
  }

  // Do some cleaning of single-site trackers to save some space
  unload.when(function() {
    Object.keys(storage.trackers).forEach(function(tracker) {
      if (Object.keys(storage.trackers[tracker]).length == 1) {
        delete storage.trackers[tracker];
      }
    });
  });

  // Initialize the tracked trackers with existing data
  Object.keys(storage.trackers).forEach(function(tracker) {
    Object.keys(storage.trackers[tracker]).forEach(function(tracked) {
      allTracked[tracked] = true;
    });
  });

  // Detect and block trackers with a content policy
  ({
    classDescription: "about:trackers content policy",
    classID: components.ID("d27de1fd-f2cc-4f84-be48-65d2510123b5"),
    contractID: "@mozilla.org/about-trackers/content-policy;1",
    QueryInterface: XPCOMUtils.generateQI([Ci.nsIContentPolicy, Ci.nsIFactory]),

    init: function() {
      let registrar = Cm.QueryInterface(Ci.nsIComponentRegistrar);
      registrar.registerFactory(this.classID, this.classDescription, this.contractID, this);

      let catMan = Cc["@mozilla.org/categorymanager;1"].getService(Ci.nsICategoryManager);
      catMan.addCategoryEntry("content-policy", this.contractID, this.contractID, false, true);

      unload.when(function() {
        catMan.deleteCategoryEntry("content-policy", this.contractID, false);

        // This needs to run asynchronously, see bug 753687
        Services.tm.currentThread.dispatch(function() {
          registrar.unregisterFactory(this.classID, this);
        }.bind(this), Ci.nsIEventTarget.DISPATCH_NORMAL);
      }.bind(this));
    },

    shouldLoad: function(contentType, contentLocation, requestOrigin, context, mimeTypeGuess, extra) {
      // Allow everything temporarily when the user reloads
      if (acceptForReload) {
        return Ci.nsIContentPolicy.ACCEPT;
      }

      try {
        // Ignore top level browser document loads
        if (contentType == Ci.nsIContentPolicy.TYPE_DOCUMENT) {
          return Ci.nsIContentPolicy.ACCEPT;
        }

        // Return to normal behavior (not blocking) for private browsing windows
        let topWindow = (context.ownerDocument || context).defaultView.top;
        if (privateBrowsing.isPrivate(topWindow)) {
          return Ci.nsIContentPolicy.ACCEPT;
        }

        // Ignore requests that share a base domain
        let trackerDomain = Services.eTLD.getBaseDomain(contentLocation);
        let topLevel = topWindow.location.host;
        let contextDomain = Services.eTLD.getBaseDomainFromHost(topLevel);
        if (trackerDomain == contextDomain) {
          return Ci.nsIContentPolicy.ACCEPT;
        }

        // Always allow known not-tracking domains
        if (domainPrefs.knownNotTrackers[trackerDomain]) {
          return Ci.nsIContentPolicy.ACCEPT;
        }

        // We have a 3rd-party tracker, so initialize if it's new
        if (storage.trackers[trackerDomain] == null) {
           storage.trackers[trackerDomain] = {};
        }

        // Include this site as tracked and check for auto-block
        if (storage.trackers[trackerDomain][contextDomain] == null) {
          storage.trackers[trackerDomain][contextDomain] = 1;
          allTracked[contextDomain] = true;
          updateAutoBlock(trackerDomain);
        }

        // Check if this tracker should get cookies blocked
        if (storage.blocked[trackerDomain] == AUTO_BLOCK_COOKIE ||
            domainPrefs.potentialTrackers[trackerDomain]) {
          unCookieNext = contentLocation.spec;
          return Ci.nsIContentPolicy.ACCEPT;
        }
        // Block the connection for automatic and manual blocking
        else if (storage.blocked[trackerDomain]) {
          return Ci.nsIContentPolicy.REJECT_REQUEST;
        }
      }
      catch(ex) {}
      return Ci.nsIContentPolicy.ACCEPT;
    },

    shouldProcess: function(contentType, contentLocation, requestOrigin, context, mimeType, extra) {
      return Ci.nsIContentPolicy.ACCEPT;
    },

    createInstance: function(outer, iid) {
      if (outer) {
        throw Cr.NS_ERROR_NO_AGGREGATION;
      }
      return this.QueryInterface(iid);
    }
  }).init();

  // Keep track of the next url that should have cookies removed
  let unCookieNext = null;

  // Watch for requests that happen immediately after accepting from shouldLoad
  on("http-on-modify-request", unCookier = function({subject}) {
    // Nothing to do if there's no url to uncookie
    if (unCookieNext == null) {
      return;
    }

    // Remove the cookie header for the url that matches
    let httpChannel = subject.QueryInterface(Ci.nsIHttpChannel);
    if (httpChannel.originalURI.spec == unCookieNext) {
      httpChannel.setRequestHeader("cookie", "", false);
    }

    // Always clear if we got the request or not (cache hit = no request)
    unCookieNext = null;
  });

  // Handle about:trackers requests
  Factory({
    contract: "@mozilla.org/network/protocol/about;1?what=trackers",

    Component: Class({
      extends: Unknown,
      interfaces: ["nsIAboutModule"],

      getURIFlags: function(uri) {
        return 0;
      },

      newChannel: function(uri) {
        let chan = Services.io.newChannel(data.url("trackers.html"), null, null);
        chan.originalURI = uri;
        return chan;
      }
    })
  });

  // Add functionality into about:trackers page loads
  PageMod({
    contentScriptFile: [data.url("trackers.js")],
    include: ["about:trackers"],

    onAttach: function(worker) {
      // Build a mapping of which trackers have cookies
      let cookied = {};
      Object.keys(storage.trackers).forEach(function(tracker) {
        cookied[tracker] = isCookied(tracker);
      });

      // Update the page with stored values
      worker.port.emit("show_threshold", storage.autoBlockThreshold, CONNECTION_MULTIPLIER);
      worker.port.emit("show_trackers", storage.trackers, storage.blocked, cookied);

      // Allow clearing all custom settings and blockings
      worker.port.on("reset", function() {
        storage.autoBlockThreshold = DEFAULT_AUTO_BLOCK_THRESHOLD;
        storage.blocked = {};
        updateAllAutoBlocked(false);
      });

      // Save changes to the threshold
      worker.port.on("set_threshold", function(threshold) {
        storage.autoBlockThreshold = threshold;
        updateAllAutoBlocked(true);
      });

      // Save changes to the block status for a tracker
      worker.port.on("toggle_block", function(tracker) {
        storage.blocked[tracker] = +!storage.blocked[tracker];
        worker.port.emit("update_block", tracker, storage.blocked[tracker]);
      });

      // Update the auto-blocked state for all trackers and notify updates
      function updateAllAutoBlocked(notify) {
        Object.keys(storage.trackers).forEach(function(tracker) {
          // Update the UI for trackers if changed
          if (updateAutoBlock(tracker) && notify) {
            worker.port.emit("update_block", tracker, storage.blocked[tracker]);
          }
        });
      }
    }
  });

  // Detect if the user hits reload to temporarily disable blocking
  let acceptForReload = false;
  new WindowTracker({
    onReload: function(event) {
      acceptForReload = true;
      setTimeout(function() {
        acceptForReload = false;
      }, RELOAD_AUTO_ACCEPT_DURATION);
    },

    onTrack: function(window) {
      let reload = window.document.getElementById("Browser:Reload");
      if (reload != null) {
        reload.addEventListener("command", this.onReload);
      }
    },

    onUntrack: function(window) {
      let reload = window.document.getElementById("Browser:Reload");
      if (reload != null) {
        reload.removeEventListener("command", this.onReload);
      }
    }
  });

  // Watch for preference changes to list of domains
  let domainPrefs = {};
  const ALLOWED_API_PREF = "allowedAPIDomains";
  ["knownNotTrackers", "potentialTrackers"].forEach(function(pref) {
    Preferences.on(pref, updateDomains);
    function updateDomains() {
      domainPrefs[pref] = {};

      // Short circuit if there's nothing to do
      let userValue = Preferences.prefs[pref].trim();
      if (userValue == "") {
        return;
      }

      // Convert the array of domains to an object
      userValue.split(/\s*,\s*/).forEach(function(domain) {
        domainPrefs[pref][domain] = true;
      });
    }
    updateDomains();
  });
};

/**
 * Determine if a tracker is using cookies.
 */
function isCookied(tracker) {
  return Services.cookies.countCookiesFromHost(tracker) > 0;
}

/**
 * Update the auto-blocked-ness of a tracker. Returns true if changed.
 */
function updateAutoBlock(tracker) {
  // Ignore user-set blocked values
  let oldBlocked = storage.blocked[tracker];
  if (typeof oldBlocked == "number") {
    return false;
  }

  // Figure out the new blocked status for cookied sites (uncookied go free)
  let newBlocked;
  if (isCookied(tracker)) {
    // Check the number of tracked sites against the thresholds
    let numTracked = Object.keys(storage.trackers[tracker]).length;
    if (numTracked >= storage.autoBlockThreshold * CONNECTION_MULTIPLIER) {
      // For trackers that are tracked, continue to block cookies because the
      // user visits this site
      if (allTracked[tracker]) {
        newBlocked = AUTO_BLOCK_COOKIE;
      }
      // Fully block the connection for unvisited trackers
      else {
        newBlocked = AUTO_BLOCK_CONNECTION;
      }
    }
    // Start blocking cookies for trackers that pass the first threshold
    else if (numTracked >= storage.autoBlockThreshold) {
      newBlocked = AUTO_BLOCK_COOKIE;
    }
  }

  // Change if necessary and inform if so
  if (newBlocked != oldBlocked) {
    storage.blocked[tracker] = newBlocked;
    return true;
  }
  return false;
}

// Keep a hard reference to the observer while the add-on is running
let unCookier;
