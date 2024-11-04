import { ortbConverter } from '../libraries/ortbConverter/converter.js';
import { registerBidder } from '../src/adapters/bidderFactory.js';
import { BANNER } from '../src/mediaTypes.js';

const BIDDER_CODE = 'mobkoi';
const DEFAULT_BIDDING_ENDPOINT = 'https://adserver.mobkoi.com/bid';

const getBidServerEndpoint = (bidRequest) => {
  return bidRequest.params.bidingEndpoint || DEFAULT_BIDDING_ENDPOINT;
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
      return {
        method: 'POST',
        url: biddingEndpoint,
        data: {
          ortb: converter.toORTB({ bidRequests: [currentBidRequest], bidderRequest }),
          bidParams: currentBidRequest.params,
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

    // eslint-disable-next-line no-console
    console.log({ serverResponse, bidRequest, prebidBidResponse });
    return prebidBidResponse.bids;
  },

};
registerBidder(spec);
