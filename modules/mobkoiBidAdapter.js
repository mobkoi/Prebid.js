import { ortbConverter } from '../libraries/ortbConverter/converter.js';
import { registerBidder } from '../src/adapters/bidderFactory.js';
import { BANNER } from '../src/mediaTypes.js';

const BIDDER_CODE = 'mobkoi';
const DEFAULT_BIDDING_ENDPOINT = 'https://adserver.mobkoi.com/bid';
const PARAMS_BIDDING_ENDPOINT = 'biddingEndpoint';

const getBidServerEndpoint = (bidRequest) => {
  return bidRequest.params[PARAMS_BIDDING_ENDPOINT] || DEFAULT_BIDDING_ENDPOINT;
}

const converter = ortbConverter({
  context: {
    netRevenue: true,
    ttl: 30,
  },
  bidResponse(buildBidResponse, bid, context) {
    const bidResponse = buildBidResponse(bid, context);
    return bidResponse;
  }
});

export const spec = {
  code: BIDDER_CODE,
  supportedMediaTypes: [BANNER],

  isBidRequestValid: function (bid) {
    return true;
  },

  buildRequests: function (validBidRequests, bidderRequest) {
    return validBidRequests.map(currentBidRequest => {
      const biddingEndpoint = getBidServerEndpoint(currentBidRequest)
      // Omit bidding endpoint from bidParams
      const { [PARAMS_BIDDING_ENDPOINT]: _, ...filteredParams } = currentBidRequest.params;
      return {
        method: 'POST',
        url: biddingEndpoint,
        options: {
          contentType: 'application/json',
        },
        data: {
          ortb: converter.toORTB({ bidRequests: [currentBidRequest], bidderRequest }),
          bidParams: filteredParams,
        },
      };
    });
  },

  interpretResponse: function (serverResponse, bidRequest) {
    if (!serverResponse.body) return [];

    const responseBody = {...serverResponse.body, seatbid: serverResponse.body.seatbid};
    const prebidBidResponse = converter.fromORTB({
      request: bidRequest.data.ortb,
      response: responseBody,
    });

    return prebidBidResponse.bids;
  },

};
registerBidder(spec);
