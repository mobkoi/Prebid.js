import adapter from '../libraries/analyticsAdapter/AnalyticsAdapter.js';
import adapterManager from '../src/adapterManager.js';
import { EVENTS } from '../src/constants.js';
import { logInfo, logError } from '../src/utils.js';
import { sendBeacon, ajax } from '../src/ajax.js';

const BIDDER_CODE = 'mobkoi';
const analyticsType = 'endpoint';
const GVL_ID = 898;
const {
  BID_TIMEOUT,
  BID_REJECTED,
  NO_BID,
  SEAT_NON_BID,
  BIDDER_ERROR,
  PAAPI_NO_BID,
  PAAPI_ERROR,
} = EVENTS;

/**
 * Events that are considered as loss bid events
 */
const LOSS_BID_EVENTS = [
  BID_TIMEOUT,
  BID_REJECTED,
  NO_BID,
  SEAT_NON_BID,
  BIDDER_ERROR,
  PAAPI_NO_BID,
  PAAPI_ERROR,
];

let initOptions = {};

function handleLossBidEvents(eventType, args) {
  const payload = {
    eventType,
    args
  };

  console.log('handleLossBidEvents', payload);

  if (!sendBeacon(initOptions.options.endpoint, payload)) {
    // Fallback to using AJAX if Beacon API is not supported
    ajax(initOptions.options.endpoint, undefined, payload, {
      contentType: 'text/plain',
      method: 'POST',
      withCredentials: false, // No user-specific data is tied to the request
      // referrerPolicy: 'unsafe-url',
      crossOrigin: true
    });
  }
}

let mobkoiAnalytics = Object.assign(adapter({analyticsType}), {
  track({
    eventType,
    args
  }) {
    logInfo(`eventType: ${eventType}`, args);

    if (LOSS_BID_EVENTS.includes(eventType)) {
      handleLossBidEvents(eventType, args);
    }
  }
});

// save the base class function
mobkoiAnalytics.originEnableAnalytics = mobkoiAnalytics.enableAnalytics;

// override enableAnalytics so we can get access to the config passed in from the page
mobkoiAnalytics.enableAnalytics = function (config) {
  initOptions = config.options;
  if (!config.options.publisherId) {
    logError('PublisherId option is not defined. Analytics won\'t work');
    return;
  }

  if (!config.options.endpoint) {
    logError('Endpoint option is not defined. Analytics won\'t work');
    return;
  }

  logInfo('mobkoiAnalytics.enableAnalytics', initOptions);
  mobkoiAnalytics.originEnableAnalytics(config); // call the base class function
};

adapterManager.registerAnalyticsAdapter({
  adapter: mobkoiAnalytics,
  code: BIDDER_CODE,
  gvlid: GVL_ID
});

export default mobkoiAnalytics;
