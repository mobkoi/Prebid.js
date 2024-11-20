import adapter from '../libraries/analyticsAdapter/AnalyticsAdapter.js';
import adapterManager from '../src/adapterManager.js';
import { EVENTS } from '../src/constants.js';
import { ajax } from '../src/ajax.js';
import {
  logInfo,
  logWarn,
  logError,
  _each,
  pick,
  triggerPixel,
  debugTurnedOn,
  mergeDeep,
  isEmpty
} from '../src/utils.js';

const BIDDER_CODE = 'mobkoi';
const analyticsType = 'endpoint';
const GVL_ID = 898;

/**
 * Order by events lifecycle
 */
const {
  // Order events
  AUCTION_INIT,
  BID_RESPONSE,
  AUCTION_END,
  AD_RENDER_SUCCEEDED,
  BID_WON,
  BIDDER_DONE,

  // Error events (Not in order)
  AUCTION_TIMEOUT,
  NO_BID,
  BID_REJECTED,
  BIDDER_ERROR,
  AD_RENDER_FAILED,
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

/**
 * Some fields contain large data that are not useful for debugging. This
 * constant contains the fields that should be omitted from the payload and in
 * error messages.
 */
const COMMON_FIELDS_TO_OMIT = ['ad', 'adm'];

class LocalContext {
  /**
   * A map of impression ID (ORTB terms) to BidContext object
   */
  bidContexts = {};

  /**
   * Shouldn't be accessed directly. Use the getter and mergePayload method instead.
   */
  _commonPayload = {};
  /**
   * The payload that is common to all bid contexts. The payload will be
   * submitted to the server along with the debug events.
   */
  get payload() {
    return this._commonPayload;
  }
  /**
   * To avoid overriding the payload object, we merge the new values to
   * the existing payload object.
   * @param {*} newValues Object containing new values to be merged
   */
  mergePayload(newValues) {
    mergeDeep(this._commonPayload, newValues);
  }

  /**
   * The Prebid auction object but only contains the key fields that we
   * interested in.
   */
  auction = null;

  /**
   * Auction.bidderRequests object
   */
  bidderRequests = null;

  /**
   * Cache the debug events that are common to all bid contexts.
   * When a new bid context is created, the events will be pushed to the new
   * context.
   */
  commonBidContextEvents = [];

  initialise(auction) {
    this.auction = pick(auction, ['auctionId', 'auctionEnd']);
    this.bidderRequests = auction.bidderRequests;
  }

  /**
   * Retrieve the BidContext object by the bid object. If the bid context is not
   * available, it will create a new one. The new bid context will returned.
   * @param {*} bid can be a prebid bid response or ortb bid response
   * @returns BidContext object
   */
  retrieveBidContext(bid) {
    const ortbId = (() => {
      try {
        const id = getOrtbId(bid);
        if (!id) {
          throw new Error(
            'ORTB ID is not available in the given bid object:' +
            JSON.stringify(omitRecursive(bid, COMMON_FIELDS_TO_OMIT), null, 2));
        }
        return id;
      } catch (error) {
        throw new Error(
          'Failed to retrieve ORTB ID from bid object. Please ensure the given object contains an ORTB ID field.\n' +
          `Sub Error: ${error.message}`
        );
      }
    })();
    const bidContext = this.bidContexts[ortbId];

    if (bidContext) {
      return bidContext;
    }

    /**
     * Create a new context object and return it.
     */
    let newBidContext = new BidContext({
      localContext: this,
      prebidOrOrtbBidResponse: bid,
    });

    /**
     * Add the data that store in local context to the new bid context.
     */
    _each(
      this.commonBidContextEvents,
      event => newBidContext.pushEvent(event)
    );
    // Merge common payload to the new bid context
    newBidContext.mergePayload(this.payload);

    this.bidContexts[ortbId] = newBidContext;
    return newBidContext;
  }

  /**
   * Immediately trigger the loss beacon for all bids (bid contexts) that haven't won the auction.
   */
  triggerAllLossBidLossBeacon() {
    _each(this.bidContexts, (bidContext) => {
      const { ortbBidResponse, bidWin, lurlTriggered } = bidContext;
      if (ortbBidResponse.lurl && !bidWin && !lurlTriggered) {
        logInfo('TriggerLossBeacon. impid:', ortbBidResponse.impid);
        sendGetRequest(ortbBidResponse.lurl);
        // Update the flog. Don't wait for the response to continue to avoid race conditions
        bidContext.lurlTriggered = true;
      }
    });
  }

  /**
   * Push an debug event to all bid contexts. This is useful for events that are
   * related to all bids in the auction.
   * @param {*} debugEvent
   * @param {*} payload Field values from event args that are useful for
   * debugging. Payload cross events will merge into one object.
   */
  pushEventToAllBidContexts(debugEvent, payload) {
    this.commonBidContextEvents.push(debugEvent);
    this.mergePayload(payload);

    if (isEmpty(this.bidContexts)) {
      this._commonBidContextEventsFlushed = false;
      return;
    }

    _each(this.bidContexts, (bidContext) => {
      bidContext.pushEvent(debugEvent, this.payload);
    });
  }

  /**
   * A flag to indicate if the common events have been flushed to the server.
   * This is useful to avoid submitting the same events multiple times.
   */
  _commonBidContextEventsFlushed = false;

  /**
   * Flush all debug events in all bid contexts as well as the common events (in
   * Local Context) to the server.
   */
  async flushAllDebugEvents() {
    if (this.commonBidContextEvents.length < 0 && isEmpty(this.bidContexts)) {
      logInfo('No debug events to flush');
      return;
    }

    const flushPromises = [];

    // If there are no bid contexts, and there are error events, submit the
    // common events to the server
    if (
      isEmpty(this.bidContexts) &&
      !this._commonBidContextEventsFlushed &&
      this.commonBidContextEvents.some(
        event => event.level === DEBUG_EVENT_LEVELS.error ||
          event.level === DEBUG_EVENT_LEVELS.warn
      )
    ) {
      logInfo('Flush common events to the server');
      flushPromises.push(postAjax(
        `${initOptions.endpoint}/debug`,
        {
          impid: getImpId(this.payload),
          ortbId: safeGetOrtbId(this.payload),
          events: this.commonBidContextEvents,
          bidWin: null,
          payload: this.payload,
        }
      ));

      this._commonBidContextEventsFlushed = true;
    }

    flushPromises.push(
      ...Object.values(this.bidContexts)
        .map(async (currentBidContext) => {
          logInfo('Flush bid context events to the server', currentBidContext);
          return postAjax(
            `${initOptions.endpoint}/debug`,
            {
              impid: currentBidContext.impid,
              ortbId: currentBidContext.ortbId,
              bidWin: currentBidContext.bidWin,
              events: currentBidContext.events,
              payload: currentBidContext.payload,
            }
          );
        }));

    await Promise.all(flushPromises);
  }
}

/**
 * Select key fields from the given object based on the object type. This is
 * useful for debugging to reduce the size of the payload.
 * @param {*} objType The custom type of the object. Return by determineObjType function.
 * @param {*} eventArgs The args object that is passed in to the event handler
 * or any supported object.
 * @returns the clone of the given object but only contains the key fields
 */
function pickKeyFields(objType, eventArgs) {
  switch (objType) {
    case OBJECT_TYPES.AUCTION: {
      return pick(eventArgs, [
        'auctionId',
        'adUnitCodes',
        'auctionStart',
        'auctionEnd',
        'auctionStatus',
        'bidderRequestId',
        'timeout',
        'timestamp',
      ]);
    }
    case OBJECT_TYPES.BIDDER_REQUEST: {
      return pick(eventArgs, [
        'auctionId',
        'bidId',
        'bidderCode',
        'bidderRequestId',
        'timeout'
      ]);
    }
    case OBJECT_TYPES.ORTB_BID: {
      return pick(eventArgs, [
        'impid', 'id', 'price', 'cur', 'crid', 'cid', 'lurl', 'cpm'
      ]);
    }
    case OBJECT_TYPES.PREBID_RESPONSE_INTERPRETED: {
      return {
        ...pick(eventArgs, [
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
          'timeToRespond',
          'rejectionReason',
          'ortbId',
          'auctionId',
          'mediaType',
          'bidderRequestId',
        ]),
        ortbBidResponse: pickKeyFields(OBJECT_TYPES.ORTB_BID, eventArgs.ortbBidResponse),
      };
    }
    case OBJECT_TYPES.PREBID_BID_REQUEST: {
      return {
        ...pick(eventArgs, [
          'bidderRequestId'
        ]),
        bids: eventArgs.bids.map(
          bid => pickKeyFields(OBJECT_TYPES.PREBID_RESPONSE_NOT_INTERPRETED, bid)
        ),
      };
    }
    case OBJECT_TYPES.AD_DOC_AND_PREBID_BID: {
      return {
        // bid: 'Not included to reduce payload size',
        doc: pick(eventArgs.doc, ['visibilityState', 'readyState', 'hidden']),
      };
    }
    case OBJECT_TYPES.AD_DOC_AND_PREBID_BID_WITH_ERROR: {
      return {
        // bid: 'Not included to reduce payload size',
        reason: eventArgs.reason,
        message: eventArgs.message,
        doc: pick(eventArgs.doc, ['visibilityState', 'readyState', 'hidden']),
      }
    }
    case OBJECT_TYPES.BIDDER_ERROR_ARGS: {
      return {
        bidderRequest: pickKeyFields(OBJECT_TYPES.BIDDER_REQUEST, eventArgs.bidderRequest),
        error: eventArgs.error?.toJSON ? eventArgs.error?.toJSON()
          : (eventArgs.error || 'Failed to convert error object to JSON'),
      };
    }
    default: {
      // Include the entire object for debugging
      return { eventArgs };
    }
  }
}

let mobkoiAnalytics = Object.assign(adapter({analyticsType}), {
  localContext: new LocalContext(),
  async track({
    eventType,
    args: eventArgs
  }) {
    try {
      switch (eventType) {
        case AUCTION_INIT: {
          logTrackEvent(eventType, eventArgs);
          const argsType = determineObjType(eventArgs);
          const auction = eventArgs;
          this.localContext.initialise(auction);
          this.localContext.pushEventToAllBidContexts(
            new DebugEvent({
              eventType,
              level: DEBUG_EVENT_LEVELS.info,
              timestamp: auction.timestamp,
            }),
            {
              [argsType]: pickKeyFields(argsType, eventArgs)
            }
          );
          break;
        }
        case BID_RESPONSE: {
          logTrackEvent(eventType, eventArgs);
          const argsType = determineObjType(eventArgs);
          const prebidBid = eventArgs;
          const bidContext = this.localContext.retrieveBidContext(prebidBid);
          bidContext.pushEvent(
            new DebugEvent({
              eventType,
              level: DEBUG_EVENT_LEVELS.info,
            }),
            {
              [argsType]: pickKeyFields(argsType, eventArgs)
            }
          );
          break;
        }
        case BID_WON: {
          logTrackEvent(eventType, eventArgs);
          const argsType = determineObjType(eventArgs);
          const prebidBid = eventArgs;
          if (isMobkoiBid(prebidBid)) {
            this.localContext.retrieveBidContext(prebidBid).bidWin = true;
          }
          // Notify the server that the bidding results.
          this.localContext.triggerAllLossBidLossBeacon();
          // Append the bid win/loss event to all bid contexts
          _each(this.localContext.bidContexts, (bidContext) => {
            bidContext.pushEvent(
              new DebugEvent({
                eventType: bidContext.bidWin ? eventType : CUSTOM_EVENTS.BID_LOSS,
                level: DEBUG_EVENT_LEVELS.info,
              }),
              {
                [argsType]: pickKeyFields(argsType, eventArgs),
              }
            );
          });
          break;
        }
        case AUCTION_END: {
          logTrackEvent(eventType, eventArgs);
          const argsType = determineObjType(eventArgs);
          const auction = eventArgs;
          this.localContext.pushEventToAllBidContexts(
            new DebugEvent({
              eventType,
              level: DEBUG_EVENT_LEVELS.info,
              timestamp: auction.timestamp,
            }),
            {
              [argsType]: pickKeyFields(argsType, eventArgs)
            }
          );
          break;
        }
        case AUCTION_TIMEOUT:
          logTrackEvent(eventType, eventArgs);
          const argsType = determineObjType(eventArgs);
          const auction = eventArgs;
          this.localContext.pushEventToAllBidContexts(
            new DebugEvent({
              eventType,
              level: DEBUG_EVENT_LEVELS.error,
              timestamp: auction.timestamp,
            }),
            {
              [argsType]: pickKeyFields(argsType, eventArgs)
            }
          );
          break;
        case NO_BID: {
          logTrackEvent(eventType, eventArgs);
          const argsType = determineObjType(eventArgs);
          const debugEvent = new DebugEvent({
            eventType,
            level: DEBUG_EVENT_LEVELS.warn,
          });
          this.localContext.pushEventToAllBidContexts(
            debugEvent,
            {
              [argsType]: pickKeyFields(argsType, eventArgs)
            }
          );
          break;
        }
        case BID_REJECTED: {
          logTrackEvent(eventType, eventArgs);
          const argsType = determineObjType(eventArgs);
          const prebidBid = eventArgs;
          const bidContext = this.localContext.retrieveBidContext(prebidBid);
          bidContext.pushEvent(
            new DebugEvent({
              eventType,
              level: DEBUG_EVENT_LEVELS.warn,
            }),
            {
              [argsType]: pickKeyFields(argsType, eventArgs)
            }
          );
          break;
        };
        case BIDDER_ERROR: {
          logTrackEvent(eventType, eventArgs)
          const argsType = determineObjType(eventArgs);
          this.localContext.pushEventToAllBidContexts(
            new DebugEvent({
              eventType,
              level: DEBUG_EVENT_LEVELS.warn,
            }),
            {
              [argsType]: pickKeyFields(argsType, eventArgs)
            }
          );
          break;
        }
        case AD_RENDER_FAILED: {
          logTrackEvent(eventType, eventArgs);
          const argsType = determineObjType(eventArgs);
          const {bid: prebidBid} = eventArgs;
          const bidContext = this.localContext.retrieveBidContext(prebidBid);
          bidContext.pushEvent(
            new DebugEvent({
              eventType,
              level: DEBUG_EVENT_LEVELS.error,
            }),
            {
              [argsType]: pickKeyFields(argsType, eventArgs)
            }
          );
          break;
        }
        case AD_RENDER_SUCCEEDED: {
          logTrackEvent(eventType, eventArgs);
          const argsType = determineObjType(eventArgs);
          const prebidBid = eventArgs.bid;
          const bidContext = this.localContext.retrieveBidContext(prebidBid);
          bidContext.pushEvent(
            new DebugEvent({
              eventType,
              level: DEBUG_EVENT_LEVELS.info,
            }),
            {
              [argsType]: pickKeyFields(argsType, eventArgs)
            }
          );
          break;
        }
        case BIDDER_DONE: {
          logTrackEvent(eventType, eventArgs)
          const argsType = determineObjType(eventArgs);
          this.localContext.pushEventToAllBidContexts(
            new DebugEvent({
              eventType,
              level: DEBUG_EVENT_LEVELS.info,
              timestamp: eventArgs.timestamp,
            }),
            {
              [argsType]: pickKeyFields(argsType, eventArgs)
            }
          );
          this.localContext.triggerAllLossBidLossBeacon();
          await this.localContext.flushAllDebugEvents();
          break;
        }
        default:
          // Do nothing in other events
          break;
      }
    } catch (error) {
      // If there is an unexpected error, log the error and submit the error to
      // the server for debugging.
      this.localContext.pushEventToAllBidContexts(
        new DebugEvent({
          eventType,
          level: DEBUG_EVENT_LEVELS.error,
          timestamp: eventArgs.timestamp,
          note: 'Error occurred when processing this event.',
        }),
        {
          // Include the entire object for debugging
          [`${eventType}_caughtError`]: {
            // Some fields contain large data. Omits them to reduce payload size
            eventArgs: omitRecursive(eventArgs, COMMON_FIELDS_TO_OMIT),
            error: error.message,
          }
        }
      );
      throw error;
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
    } else if (
      this.payload &&
      getImpId(this.payload)
    ) {
      return getImpId(this.payload);
    } else {
      throw new Error('ORTB bid response and Prebid bid response are not available for extracting Impression ID');
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
    } else if (this.payload) {
      return getOrtbId(this.payload);
    } else {
      throw new Error('ORTB bid response and Prebid bid response are not available for extracting ORTB ID');
    }
  };

  /**
   * The prebid bid request object before converted to ORTB request in our
   * custom adapter.
   */
  get prebidBidRequest() {
    if (!this.prebidBidResponse) {
      throw new Error('Prebid bid response is not available. Accessing before assigning.');
    }

    return this.localContext.bidderRequests.flatMap(br => br.bids)
      .find(bidRequest => bidRequest.bidId === this.prebidBidResponse.requestId);
  }

  _payload = null;
  get payload() {
    return this._payload;
  }
  /**
   * To avoid overriding the payload object, we merge the new values to the
   * existing payload object.
   * @param {*} newValues Object containing new values to be merged
   */
  mergePayload(newValues) {
    mergeDeep(this._payload, newValues);
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

  /**
   * A object to store related data of a bid for easy access.
   * i.e. bid request and bid response.
   * @param {*} param0
   */
  constructor({
    localContext,
    prebidOrOrtbBidResponse: bidResponse,
  }) {
    this.localContext = localContext;
    this._payload = {};

    if (!bidResponse) {
      throw new Error('prebidOrOrtbBidResponse field is required');
    }

    const objType = determineObjType(bidResponse);
    if (![OBJECT_TYPES.ORTB_BID, OBJECT_TYPES.PREBID_RESPONSE_INTERPRETED].includes(objType)) {
      throw new Error(
        'Unable to create a new Bid Context as the given object is not a bid response object. ' +
        'Expect a Prebid Bid Object or ORTB Bid Object. Given object:\n' +
        JSON.stringify(omitRecursive(bidResponse, COMMON_FIELDS_TO_OMIT), null, 2)
      );
    }

    if (objType === OBJECT_TYPES.ORTB_BID) {
      this.ortbBidResponse = bidResponse;
      this.prebidBidResponse = null;
    } else if (objType === OBJECT_TYPES.PREBID_RESPONSE_INTERPRETED) {
      this.ortbBidResponse = bidResponse.ortbBidResponse;
      this.prebidBidResponse = bidResponse;
    } else {
      throw new Error('Expect a Prebid Bid Object or ORTB Bid Object. Given object:\n' +
        JSON.stringify(omitRecursive(bidResponse, COMMON_FIELDS_TO_OMIT), null, 2));
    }
  }

  /**
   * Push a debug event to the context which will submitted to server for debugging.
   * @param {*} bugEvent DebugEvent object
   * @param {*} payload Field values from event args that are useful for
   * debugging. Payload cross events will merge into one object.
   */
  pushEvent(bugEvent, payload = undefined) {
    if (!(bugEvent instanceof DebugEvent)) {
      throw new Error('bugEvent must be an instance of DebugEvent');
    }
    this.events.push(bugEvent);

    if (payload) {
      this.mergePayload(payload);
    }
  }
}

/**
 * A class defines the uniform structure of a debug event object.
 */
class DebugEvent {
  constructor({eventType, level, timestamp = undefined, note = undefined}) {
    if (!eventType) {
      throw new Error('eventType is required');
    }
    if (!DEBUG_EVENT_LEVELS[level]) {
      throw new Error(`Event level must be one of ${Object.keys(DEBUG_EVENT_LEVELS).join(', ')}. Given: "${level}"`);
    }
    if (timestamp && typeof timestamp !== 'number') {
      throw new Error('Timestamp must be a number');
    }
    this.eventType = eventType;
    this.level = level;
    this.timestamp = timestamp || Date.now();
    if (note) {
      this.note = note;
    }

    if (
      debugTurnedOn() &&
      (
        level === DEBUG_EVENT_LEVELS.error ||
        level === DEBUG_EVENT_LEVELS.warn
      )) {
      logWarn(`New Debug Event - Type: ${eventType} Level: ${level}.`);
    }
  }
}

/**
 * Make a POST request to the given URL with the given data.
 * @param {*} url
 * @param {*} data JSON data
 * @returns
 */
async function postAjax(url, data) {
  return new Promise((resolve, reject) => {
    try {
      logInfo('postAjax:', url, data);
      ajax(url, resolve, JSON.stringify(data), {
        contentType: 'application/json',
        method: 'POST',
        withCredentials: false, // No user-specific data is tied to the request
        referrerPolicy: 'unsafe-url',
        crossOrigin: true
      });
    } catch (error) {
      reject(new Error(
        `Failed to make post request to endpoint "${url}". With data: ` +
        JSON.stringify(omitRecursive(data, COMMON_FIELDS_TO_OMIT), null, 2),
        { error: error.message }
      ));
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

/**
 * The primary ID we use for identifying bid requests and responses.
 * Get ORTB ID from Prebid Bid response or ORTB bid response object.
 */
function getOrtbId(bid) {
  if (bid.id) {
    if (debugTurnedOn()) {
      try {
        const objType = determineObjType(bid);
        if (!objType === OBJECT_TYPES.ORTB_BID) {
          logWarn(
            `Given object is not an ORTB bid response. Given object type: ${objType}.`,
            bid
          );
        }
      } catch (error) {
        logWarn('Error when determining object type. Given object:', bid);
      }
    }
    // If it's an ORTB bid response
    return bid.id;
  } else if (bid.ortbId) {
    // If it's a Prebid bid response
    return bid.ortbId;
  } else if (bid.ortbBidResponse && bid.ortbBidResponse.id) {
    // If it's a Prebid bid response with ORTB response. i.e. interpreted response
    return bid.ortbBidResponse.id;
  } else {
    throw new Error('Not a valid bid object. Given object:\n' +
      JSON.stringify(omitRecursive(bid, COMMON_FIELDS_TO_OMIT), null, 2));
  }
}

/**
 * Safely get ORTB ID from a bid object. If the ID is not available, it will
 * return null.
 * @param {*} obj
 * @returns string | null
 */
function safeGetOrtbId(obj) {
  try {
    return getOrtbId(obj);
  } catch (error) {
    return null;
  }
}

/**
 * Impression ID is named differently in different objects. This function will
 * return the impression ID from the given bid object.
 * @param {*} bid ORTB bid response or Prebid bid response or Prebid bid request
 * @returns string | null
 */
function getImpId(bid) {
  return (bid && (bid.impid || bid.requestId || bid.bidId)) || null;
}

function logTrackEvent(eventType, eventArgs) {
  if (!debugTurnedOn()) {
    return;
  }
  const argsType = (() => {
    try {
      return determineObjType(eventArgs);
    } catch (error) {
      logError(`Error when logging track event: [${eventType}]\n`, error);
      return 'Unknown';
    }
  })();
  logInfo(`Track event: [${eventType}]. Args Type Determination: ${argsType}`, eventArgs);
}

/**
 * Various types of objects that provided by Prebid tracking events.
 */
const OBJECT_TYPES = {
  AUCTION: 'prebid_auction',
  BIDDER_REQUEST: 'bidder_request',
  ORTB_BID: 'ortb_bid',
  PREBID_RESPONSE_INTERPRETED: 'prebid_bid_interpreted',
  PREBID_RESPONSE_NOT_INTERPRETED: 'prebid_bid_not_interpreted',
  PREBID_BID_REQUEST: 'prebid_bid_request',
  AD_DOC_AND_PREBID_BID: 'ad_doc_and_prebid_bid',
  AD_DOC_AND_PREBID_BID_WITH_ERROR: 'ad_doc_and_prebid_bid_with_error',
  BIDDER_ERROR_ARGS: 'bidder_error_args',
};

/**
 * Fields that are unique to objects used to identify the object type.
 */
const OBJECT_TYPES_UNIQUE_FIELDS = {
  [OBJECT_TYPES.AUCTION]: ['auctionStatus'],
  [OBJECT_TYPES.BIDDER_REQUEST]: ['bidderRequestId'],
  [OBJECT_TYPES.ORTB_BID]: ['adm', 'impid'],
  [OBJECT_TYPES.PREBID_RESPONSE_INTERPRETED]: ['requestId', 'ortbBidResponse'],
  [OBJECT_TYPES.PREBID_RESPONSE_NOT_INTERPRETED]: ['requestId'],
  [OBJECT_TYPES.PREBID_BID_REQUEST]: ['bidId'],
  [OBJECT_TYPES.AD_DOC_AND_PREBID_BID]: ['doc', 'bid'],
  [OBJECT_TYPES.AD_DOC_AND_PREBID_BID_WITH_ERROR]: ['bid', 'reason', 'message'],
  [OBJECT_TYPES.BIDDER_ERROR_ARGS]: ['error', 'bidderRequest'],
};

/**
 * Determine the type of the given object based on the object's fields.
 * This is useful for identifying the type of object that is passed in to the
 * handler functions.
 * @param {*} eventArgs
 * @returns string
 */
function determineObjType(eventArgs) {
  if (typeof eventArgs !== 'object' || eventArgs === null) {
    throw new Error(
      'determineObjType: Expect an object. Given object is not an object or null. Given object:' +
      JSON.stringify(omitRecursive(eventArgs, COMMON_FIELDS_TO_OMIT), null, 2)
    );
  }

  let objType = null;
  for (const type of Object.values(OBJECT_TYPES)) {
    const identifyFields = OBJECT_TYPES_UNIQUE_FIELDS[type];
    if (!identifyFields) {
      throw new Error(
        `Identify fields for type "${type}" is not defined in COMMON_OBJECT_UNIT_FIELDS.`
      );
    }
    // If all fields are available in the object, then it's the type we are looking for
    if (identifyFields.every(field => eventArgs.hasOwnProperty(field))) {
      objType = type;
      break;
    }
  }

  if (!objType) {
    throw new Error(
      'Unable to determine track args type. Please update COMMON_OBJECT_UNIT_FIELDS for the new object type.\n' +
      'Given object:\n' +
      JSON.stringify(omitRecursive(eventArgs, COMMON_FIELDS_TO_OMIT), null, 2)
    );
  }

  return objType;
}

/**
 * Recursively omit the given keys from the object.
 * @param {*} obj - The object to process.
 * @param {Array} keysToOmit - The keys to omit from the object.
 * @param {*} [placeholder='OMITTED'] - The placeholder value to use for omitted keys.
 * @returns {Object} - A clone of the given object with the specified keys omitted.
 */
function omitRecursive(obj, keysToOmit, placeholder = 'OMITTED') {
  return Object.keys(obj).reduce((acc, currentKey) => {
    // If the current key is in the keys to omit, replace the value with the placeholder
    if (keysToOmit.includes(currentKey)) {
      acc[currentKey] = placeholder;
      return acc;
    }

    // If the current value is an object and not null, recursively omit keys
    if (typeof obj[currentKey] === 'object' && obj[currentKey] !== null) {
      acc[currentKey] = omitRecursive(obj[currentKey], keysToOmit, placeholder);
    } else {
      // Otherwise, directly assign the value to the accumulator object
      acc[currentKey] = obj[currentKey];
    }
    return acc;
  }, {});
}
