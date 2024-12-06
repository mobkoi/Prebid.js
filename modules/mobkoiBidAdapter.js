import { ortbConverter } from '../libraries/ortbConverter/converter.js';
import { registerBidder } from '../src/adapters/bidderFactory.js';
import { BANNER } from '../src/mediaTypes.js';
import { _each, replaceMacros, deepAccess, deepSetValue, logError } from '../src/utils.js';

const BIDDER_CODE = 'mobkoi';
/**
 * The name of the parameter that the publisher can use to specify the ad server endpoint.
 */
const PARAM_NAME_AD_SERVER_BASE_URL = 'adServerBaseUrl';
/**
 * The list of ORTB response fields that are used in the macros. Field
 * replacement is self-implemented in the adapter. Use dot-notated path for
 * nested fields. For example, 'ad.ext.adomain'. For more information, visit
 * https://www.npmjs.com/package/dset and https://www.npmjs.com/package/dlv.
 */
const ORTB_RESPONSE_FIELDS_SUPPORT_MACROS = ['adm', 'nurl', 'lurl'];

export const converter = ortbConverter({
  context: {
    netRevenue: true,
    ttl: 30,
  },
  request(buildRequest, imps, bidderRequest, context) {
    const ortbRequest = buildRequest(imps, bidderRequest, context);
    const prebidBidRequest = context.bidRequests[0];

    ortbRequest.id = utils.getOrtbId(prebidBidRequest);

    return ortbRequest;
  },
  imp(buildImp, bidRequest, context) {
    context[PARAM_NAME_AD_SERVER_BASE_URL] = utils.getBidServerEndpointBase(bidRequest);
    return buildImp(bidRequest, context);
  },
  bidResponse(buildPrebidBidResponse, ortbBidResponse, context) {
    utils.replaceAllMacrosInPlace(ortbBidResponse, context);

    const prebidBid = buildPrebidBidResponse(ortbBidResponse, context);
    utils.addCustomFieldsToPrebidBidResponse(prebidBid, ortbBidResponse);
    return prebidBid;
  },
});

export const spec = {
  code: BIDDER_CODE,
  supportedMediaTypes: [BANNER],

  isBidRequestValid(bid) {
    if (!deepAccess(bid, 'ortb2.site.publisher.id')) {
      logError('The "ortb2.site.publisher.id" field is required in the bid request.' +
        'Please set it via the "config.ortb2.site.publisher.id" field with pbjs.setBidderConfig.'
      );
      return false;
    }

    return true;
  },

  buildRequests(prebidBidRequests, prebidBidderRequest) {
    return {
      method: 'POST',
      url: utils.getBidServerEndpointBase(prebidBidRequests[0]) + '/bid',
      options: {
        contentType: 'application/json',
      },
      data: converter.toORTB({
        bidRequests: prebidBidRequests,
        bidderRequest: prebidBidderRequest
      }),
    };
  },

  interpretResponse(serverResponse, customBidRequest) {
    if (!serverResponse.body) return [];

    const responseBody = {...serverResponse.body, seatbid: serverResponse.body.seatbid};
    const prebidBidResponse = converter.fromORTB({
      request: customBidRequest.data,
      response: responseBody,
    });

    return prebidBidResponse.bids;
  },
};

registerBidder(spec);

const utils = {
  replaceAllMacrosInPlace(ortbBidResponse, context) {
    const macros = {
      // ORTB macros
      AUCTION_PRICE: ortbBidResponse.price,
      AUCTION_IMP_ID: ortbBidResponse.impid,
      AUCTION_CURRENCY: ortbBidResponse.cur,
      AUCTION_BID_ID: context.bidderRequest.auctionId,

      // Custom macros
      BIDDING_API_BASE_URL: context[PARAM_NAME_AD_SERVER_BASE_URL],
      CREATIVE_ID: ortbBidResponse.crid,
      CAMPAIGN_ID: ortbBidResponse.cid,
      ORTB_ID: ortbBidResponse.id,
      PUBLISHER_ID: deepAccess(context, 'bidRequest.ortb2.site.publisher.id'),
    };

    _each(ORTB_RESPONSE_FIELDS_SUPPORT_MACROS, ortbField => {
      deepSetValue(
        ortbBidResponse,
        ortbField,
        replaceMacros(deepAccess(ortbBidResponse, ortbField), macros)
      );
    });
  },

  getBidServerEndpointBase (prebidBidRequest) {
    const adServerBaseUrl = prebidBidRequest.params[PARAM_NAME_AD_SERVER_BASE_URL];

    if (!adServerBaseUrl) {
      throw new Error(`The "${PARAM_NAME_AD_SERVER_BASE_URL}" parameter is required in Ad unit bid params.`);
    }
    return adServerBaseUrl;
  },

  /**
   * Append custom fields to the prebid bid response. so that they can be accessed
   * in various event handlers.
   * @param {*} prebidBidResponse
   * @param {*} ortbBidResponse
   */
  addCustomFieldsToPrebidBidResponse(prebidBidResponse, ortbBidResponse) {
    prebidBidResponse.ortbBidResponse = ortbBidResponse;
    prebidBidResponse.ortbId = ortbBidResponse.id;
  },

  /**
   * We use the bidderRequestId as the ortbId. We could do so because we only
   * make one ORTB request per Prebid Bidder Request.
   * The ID field named differently when the value passed on to different contexts.
   * Make sure the implementation of this function matches utils.getOrtbId in
   * mobkoiAnalyticsAdapter.js.
   * @param {*} bid Prebid Bidder Request Object or Prebid Bid Response/Request
   * or ORTB Request/Response Object
   * @returns {string} The ORTB ID
   * @throws {Error} If the ORTB ID cannot be found in the given object.
   */
  getOrtbId(bid) {
    const ortbId =
      // called bidderRequestId in Prebid Request
      bid.bidderRequestId ||
      // called seatBidId in Prebid Bid Response Object
      bid.seatBidId ||
      // called ortbId in Interpreted Prebid Response Object
      bid.ortbId ||
      // called id in ORTB object
      (Object.hasOwn(bid, 'imp') && bid.id);

    if (!ortbId) {
      throw new Error('Unable to find the ORTB ID in the bid object. Given Object:\n' +
        JSON.stringify(bid, null, 2)
      );
    }

    return ortbId;
  }
}
