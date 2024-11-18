import adapter from '../libraries/analyticsAdapter/AnalyticsAdapter.js';
import adapterManager from '../src/adapterManager.js';
import { EVENTS } from '../src/constants.js';
import { logInfo, logWarn, logError, _each, pick, triggerPixel } from '../src/utils.js';
import { ajax } from '../src/ajax.js';

const BIDDER_CODE = 'mobkoi';
const analyticsType = 'endpoint';
const GVL_ID = 898;

/**
 * Order by events lifecycle
 */
const {
  AUCTION_INIT,
  BID_RESPONSE,
  BID_WON,

  AUCTION_TIMEOUT,
  BID_TIMEOUT,
  NO_BID,
  BID_REJECTED,
  SEAT_NON_BID,
  BIDDER_ERROR,

  AUCTION_END,

  AD_RENDER_FAILED,
  AD_RENDER_SUCCEEDED,
  BIDDER_DONE,
} = EVENTS;

const CUSTOM_EVENTS = {
  BID_LOSS: 'bidLoss',
};

/**
 * The options that are passed in from the page
 */
let initOptions = {};

const DEBUG_EVENT_LEVELS = {
  info: 'info',
  warn: 'warn',
  error: 'error',
};

class DebugEvent {
  constructor(eventType, level, payload) {
    if (!eventType) {
      throw new Error('Event type is required');
    }
    if (!DEBUG_EVENT_LEVELS[level]) {
      throw new Error(`Event level must be one of ${Object.keys(DEBUG_EVENT_LEVELS).join(', ')}. Given: "${level}"`);
    }
    if (payload !== null && typeof payload !== 'object') {
      throw new Error('Event payload must be an object');
    }
    this.eventType = eventType;
    this.payload = payload;
    this.timestamp = payload.timestamp || Date.now();
  }
}

class BidContext {
  /**
   * The impression ID (ORTB term) of the bid. This ID is initialised in Prebid
   * bid requests. The ID is reserved in requests and responses but have
   * different names from object to object.
   */
  get impid() {
    if (this.ortbBidResponse) {
      return this.ortbBidResponse.impid;
    } else if (this.prebidBidResponse) {
      return this.prebidBidResponse.requestId;
    } else if (this.prebidBidRequest) {
      return this.prebidBidRequest.bidId;
    } else {
      throw new Error('ORTB bid response and Prebid bid response are not available');
    }
  }

  /**
   * ORTB ID generated by Ad Server
   */
  get ortbId() {
    if (this.ortbBidResponse) {
      return getOrtbId(this.ortbBidResponse);
    } else if (this.prebidBidResponse) {
      return getOrtbId(this.prebidBidResponse);
    } else {
      throw new Error('ORTB bid response and Prebid bid response are not available');
    }
  };

  /**
   * The prebid bid request object before converted to ORTB request in our
   * custom adapter.
   */
  get prebidBidRequest() {
    if (!this.prebidBidResponse) {
      throw new Error('Prebid bid response is not available');
    }

    return this.localContext.bidderRequests.flatMap(br => br.bids)
      .find(bidRequest => bidRequest.bidId === this.prebidBidResponse.requestId);
  }

  /**
   * The prebid bid response object after converted from ORTB response in our
   * custom adapter.
   */
  prebidBidResponse = null;

  /**
   * The raw ORTB bid response object from the server.
   */
  ortbBidResponse = null;

  /**
   * A flag to indicate if the bid has won the auction. It only updated to true
   * if the winning bid is from Mobkoi in the BID_WON event.
   */
  bidWin = false;

  /**
   * A flag to indicate if the loss beacon has been triggered.
   */
  lurlTriggered = false;

  /**
   * A list of DebugEvent objects
   */
  events = [];

  /**
   * Keep the reference of LocalContext object for easy accessing data.
   */
  localContext = null;

  constructor({
    localContext,
    prebidBidResponse = null,
    ortbBidResponse = null
  }) {
    this.localContext = localContext;
    this.prebidBidResponse = prebidBidResponse;
    this.ortbBidResponse = ortbBidResponse;
  }

  /**
   * Push a debug event to the context which will submitted to server for debugging
   */
  pushEvent(bugEvent) {
    if (!(bugEvent instanceof DebugEvent)) {
      throw new Error('Event must be an instance of DebugEvent');
    }
    this.events.push(bugEvent);
  }

  /**
   * Map the context object to a payload that can be submitted to the server for
   * debugging purposes.
   * @returns Debug payload object
   */
  getDebugPayload() {
    return {
      auctionId: this.prebidBidRequest.auctionId,
      impid: this.impid,
      ortbId: this.ortbId,
      events: this.events,
    };
  }

  async flushDebugEvents() {
    return postAjax(`${initOptions.endpoint}/debug`, this.getDebugPayload());
  }
}

class LocalContext {
  /**
   * A map of impression ID (ORTB terms) to BidContext object
   */
  bidContexts = {};

  /**
   * The Prebid auction object but only contains the key fields that we
   * interested in.
   */
  auction = null;

  /**
   * Auction.bidderRequests object
   */
  bidderRequests = null;

  initialise(auction) {
    this.auction = pick(auction, ['auctionId', 'auctionEnd']);
    this.bidderRequests = auction.bidderRequests;
  }

  /**
   * Append the Prebid bid response to the context object if the associated
   * BidContext has not been created yet. The object is converted by the custom
   * adapter from the ORTB response from our server.
   * @param {*} prebidBidResponse
   */
  appendBid(prebidBidResponse) {
    const bidContext = this.retrieveBidContext(prebidBidResponse);

    if (!bidContext) {
      const ortbId = getOrtbId(prebidBidResponse);
      this.bidContexts[ortbId] = new BidContext({
        localContext: this,
        prebidBidResponse,
        ortbBidResponse: prebidBidResponse.ortbBidResponse
      });
    }

    return this.retrieveBidContext(prebidBidResponse);
  }

  /**
   * Retrieve the BidContext object by the bid object.
   * @param {*} bid can be a prebid bid response or ortb bid response
   * @returns BidContext object
   */
  retrieveBidContext(bid) {
    const ortbId = getOrtbId(bid);
    return this.bidContexts[ortbId];
  }

  /**
   * Loop through all the bid contexts and trigger the loss beacon if it hasn't
   * to notify the server that the bid has lost the auction.
   */
  triggerAllLossBidLossBeacon() {
    _each(this.bidContexts, (bidContext) => {
      const { ortbBidResponse, bidWin, lurlTriggered } = bidContext;
      if (ortbBidResponse.lurl && !bidWin && !lurlTriggered) {
        logInfo('TriggerLossBeacon. impid:', ortbBidResponse.impid);
        sendGetRequest(ortbBidResponse.lurl);
        // Don't wait for the response to continue to avoid race conditions
        bidContext.lurlTriggered = true;
        bidContext.pushEvent(
          new DebugEvent(
            CUSTOM_EVENTS.BID_LOSS,
            DEBUG_EVENT_LEVELS.info,
            {
              impid: ortbBidResponse.impid,
              ortbId: ortbBidResponse.id,
              cpm: ortbBidResponse.cpm,
              lurl: ortbBidResponse.lurl,
            }
          )
        );
      }
    });
  }

  pushEventToAllBidContexts(debugEvent) {
    _each(this.bidContexts, (bidContext) => {
      bidContext.pushEvent(debugEvent);
    });
  }

  flushAllBidContextDebugEvents() {
    _each(this.bidContexts, (bidContext) => {
      bidContext.flushDebugEvents();
    });
  }

  async pushSystemError(debugEvent) {
    return postAjax(`${initOptions.endpoint}/error`, debugEvent);
  }
}

/**
 * The primary ID we use for identifying bid requests and responses.
 * Get ORTB ID from Prebid Bid response or ORTB bid response object.
 */
function getOrtbId(bid) {
  if (bid.id) {
    // If it's an ORTB bid response
    return bid.id;
  } else if (bid.ortbId) {
    // If it's a Prebid bid response
    return bid.ortbId;
  } else {
    throw new Error('Not a valid bid object. Given object:\n', JSON.stringify(bid));
  }
}

let mobkoiAnalytics = Object.assign(adapter({analyticsType}), {
  localContext: new LocalContext(),
  track({
    eventType,
    args
  }) {
    switch (eventType) {
      case AUCTION_INIT: {
        logInfo(`Event: ${eventType}`, args);
        this.localContext.initialise(args);
        this.localContext.pushEventToAllBidContexts(
          new DebugEvent(
            eventType,
            DEBUG_EVENT_LEVELS.info,
            pick(args, [
              'auctionId',
              'adUnitCodes',
              'adUnits',
              'auctionStart',
              'auctionStatus',
              'timeout',
              'timestamp',
            ])
          )
        );
        break;
      }
      case BID_RESPONSE: {
        logInfo(`Event: ${eventType}`, args);
        const prebidBid = args;
        const bidContext = this.localContext.appendBid(prebidBid);
        bidContext.pushEvent(
          new DebugEvent(
            eventType,
            DEBUG_EVENT_LEVELS.info,
            pick(prebidBid, [
              'requestId',
              'creativeId',
              'cpm',
              'currency',
              'bidderCode',
              'adUnitCode',
              'ttl',
              'adId',
              'width',
              'height',
              'requestTimestamp',
              'responseTimestamp',
              'seatBidId',
              'statusMessage',
              'timeToRespond'
            ])
          )
        );
        break;
      }
      case BID_WON: {
        logInfo(`Event: ${eventType}`, args);
        const prebidBid = args;
        if (isMobkoiBid(prebidBid)) {
          this.localContext.retrieveBidContext(prebidBid).bidWin = true;
        }
        this.localContext.triggerAllLossBidLossBeacon();

        const bidContext = this.localContext.retrieveBidContext(prebidBid);
        bidContext.pushEvent(
          new DebugEvent(
            eventType,
            DEBUG_EVENT_LEVELS.info,
            {
              ...pick(args, [
                'adId',
                'bidderCode',
                'requestId',
                'status',
                'statusMessage',
                'cpm',
                'currency',
                'creativeId',
                'adUnitCode',
                'addUnitId',
                'adId',
                'ttl',
                'width',
                'height',
                'requestTimestamp',
                'responseTimestamp',
                'timeToRespond',
              ]),
              bidWin: bidContext.bidWin,
            }
          )
        );
        break;
      }
      case AUCTION_END: {
        logInfo(`Event: ${eventType}`, args);
        const auction = args;
        this.localContext.pushEventToAllBidContexts(
          new DebugEvent(
            eventType,
            DEBUG_EVENT_LEVELS.info,
            pick(auction, [
              'auctionId',
              'auctionStatus',
              'auctionStart',
              'auctionEnd',
              'auctionStatus',
              'bidderCode',
              'bidderRequestId',
              'timestamp',
            ])
          )
        );
        break;
      }
      case AUCTION_TIMEOUT:
        logInfo(`Event: ${eventType}`, args);
        this.localContext.pushEventToAllBidContexts(
          new DebugEvent(
            eventType,
            DEBUG_EVENT_LEVELS.error,
            pick(args, [
              'auctionId',
              'auctionStatus',
              'auctionStart',
              'auctionEnd',
              'auctionStatus',
              'bidderCode',
              'bidderRequestId',
              'timestamp',
            ])
          )
        );
        break;
      case NO_BID: {
        logInfo(`Event: ${eventType}`, args);
        const prebidBid = args;
        const bidContext = this.localContext.retrieveBidContext(prebidBid);
        bidContext.pushEvent(
          new DebugEvent(
            eventType,
            DEBUG_EVENT_LEVELS.warn,
            pick(prebidBid, [
              'auctionId',
              'bidderCode',
              'bidderRequestId',
              'timeout',
            ])
          )
        );
        break;
      }
      case BID_REJECTED: {
        logInfo(`Event: ${eventType}`, args);
        const prebidBid = args;
        const bidContext = this.localContext.appendBid(prebidBid);
        bidContext.pushEvent(
          new DebugEvent(
            eventType,
            DEBUG_EVENT_LEVELS.warn,
            pick(prebidBid, [
              'rejectionReason',
              'ortbId',
              'requestId',
              'auctionId',
              'bidderCode',
              'bidderRequestId',
              'ortbBidResponse',
            ])
          )
        );
        break;
      };
      case BID_TIMEOUT:
      case SEAT_NON_BID:
      case BIDDER_ERROR: {
        logInfo(`Event: ${eventType}`, args);
        try {
          // Submit entire args object for debugging
          const debugEvent = new DebugEvent(
            eventType,
            DEBUG_EVENT_LEVELS.error,
            { args }
          );

          // If args is an auction object
          if (args.auctionId) {
            this.localContext.pushEventToAllBidContexts(debugEvent);
            break;
          }

          // Assuming args is a prebid bid object
          const prebidBid = args;
          const bidContext = this.localContext.retrieveBidContext(prebidBid);
          bidContext.pushEvent(debugEvent);
        } catch (error) {
          this.localContext.pushSystemError(
            new DebugEvent(
              eventType,
              DEBUG_EVENT_LEVELS.error,
              {
                args: args,
                warn: 'Unexpected error occurred. Please investigate.',
                error: JSON.stringify(error)
              }
            )
          );
        }
        break;
      }
      case AD_RENDER_FAILED: {
        logInfo(`Event: ${eventType}`, args);
        const prebidBid = args.bid;
        const bidContext = this.localContext.retrieveBidContext(prebidBid);
        bidContext.pushEvent(
          new DebugEvent(
            eventType,
            DEBUG_EVENT_LEVELS.error,
            pick(prebidBid, [
              'ad',
              'adId',
              'adUnitCode',
              'creativeId',
              'width',
              'height',
            ])
          )
        );
        break;
      }
      case AD_RENDER_SUCCEEDED: {
        logInfo(`Event: ${eventType}`, args);
        const prebidBid = args.bid;
        const bidContext = this.localContext.retrieveBidContext(prebidBid);
        bidContext.pushEvent(
          new DebugEvent(
            eventType,
            DEBUG_EVENT_LEVELS.info,
            pick(prebidBid, [
              'adId',
              'adUnitCode',
              'creativeId',
              'width',
              'height',
            ])
          )
        );
        break;
      }
      case BIDDER_DONE: {
        logInfo(`Event: ${eventType}`, args);
        const auction = args;
        this.localContext.pushEventToAllBidContexts(
          new DebugEvent(
            eventType,
            DEBUG_EVENT_LEVELS.info,
            pick(auction, [
              'auctionId',
              'bidderCode',
              'bidderRequestId',
              'timeout',
            ])
          )
        );
        this.localContext.triggerAllLossBidLossBeacon();
        this.localContext.flushAllBidContextDebugEvents();
        break;
      }
      default:
        // Do nothing
        break;
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

/**
 * Make a POST request to the given URL with the given data.
 * @param {*} url
 * @param {*} data JSON data
 * @returns
 */
async function postAjax(url, data) {
  return new Promise((resolve, reject) => {
    try {
      ajax(url, resolve, JSON.stringify(data), {
        contentType: 'application/json',
        method: 'POST',
        withCredentials: false, // No user-specific data is tied to the request
        referrerPolicy: 'unsafe-url',
        crossOrigin: true
      });
    } catch (error) {
      reject(new Error(`Failed to make post request to endpoint "${url}". With data: ${JSON.stringify(data)}. Error: ${error}`, {cause: error}));
    }
  });
}

/**
 * Make a GET request to the given URL. If the request fails, it will fall back
 * to AJAX request.
 * @param {*} url URL with the query string
 * @returns
 */
async function sendGetRequest(url) {
  return new Promise((resolve, reject) => {
    try {
      logInfo('triggerPixel', url);
      triggerPixel(url, resolve);
    } catch (error) {
      try {
        logWarn(`triggerPixel failed. URL: (${url}) Falling back to ajax. Error: `, error);
        ajax(url, resolve, null, {
          contentType: 'application/json',
          method: 'GET',
          withCredentials: false, // No user-specific data is tied to the request
          referrerPolicy: 'unsafe-url',
          crossOrigin: true
        });
      } catch (error) {
        // If failed with both methods, reject the promise
        reject(error);
      }
    }
  });
}

function isMobkoiBid(prebidBid) {
  return prebidBid && prebidBid.bidderCode === BIDDER_CODE;
}
