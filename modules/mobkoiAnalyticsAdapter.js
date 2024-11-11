import adapter from '../libraries/analyticsAdapter/AnalyticsAdapter.js';
import adapterManager from '../src/adapterManager.js';
import { EVENTS } from '../src/constants.js';
import { logInfo } from '../src/utils.js';

const BIDDER_CODE = 'mobkoi';
const analyticsType = 'endpoint';
const GVL_ID = 898;

let initOptions = {};

let mobkoiAnalytics = Object.assign(adapter({analyticsType}), {
  track({
    eventType,
    args
  }) {
    logInfo(`eventType: ${eventType}`, args);

    // switch (eventType) {
    //   case EVENTS.AUCTION_INIT:
    //     logInfo(`eventType: ${eventType}`, args);
    //     // handleAuctionInit(eventType, args);
    //     break;
    //   case EVENTS.BID_REQUESTED:
    //     logInfo(`eventType: ${eventType}`, args);
    //     // handleBidRequested(args);
    //     break;
    //   case EVENTS.BID_RESPONSE:
    //     logInfo(`eventType: ${eventType}`, args);
    //     // handleBidResponse(eventType, args);
    //     break;
    //   case EVENTS.NO_BID:
    //     logInfo(`eventType: ${eventType}`, args);
    //     // handleNoBid(eventType, args);
    //     break;
    //   case EVENTS.BID_TIMEOUT:
    //     logInfo(`eventType: ${eventType}`, args);
    //     // handleBidTimeout(eventType, args);
    //     break;
    //   case EVENTS.BID_WON:
    //     logInfo(`eventType: ${eventType}`, args);
    //     // handleBidWon(eventType, args);
    //     break;
    //   case EVENTS.AUCTION_END:
    //     logInfo(`eventType: ${eventType}`, args);
    //     // handleAuctionEnd();
    // }
  }
});

// save the base class function
mobkoiAnalytics.originEnableAnalytics = mobkoiAnalytics.enableAnalytics;

// override enableAnalytics so we can get access to the config passed in from the page
mobkoiAnalytics.enableAnalytics = function (config) {
  initOptions = config.options;
  logInfo('mobkoiAnalytics.enableAnalytics', initOptions);
  mobkoiAnalytics.originEnableAnalytics(config); // call the base class function
};

adapterManager.registerAnalyticsAdapter({
  adapter: mobkoiAnalytics,
  code: BIDDER_CODE,
  gvlid: GVL_ID
});

export default mobkoiAnalytics;
