#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(SpotlightPSASlabAnalysis, NSObject)

RCT_EXTERN_METHOD(
  analyzeLabel:(NSString *)imageURI
  resolver:(RCTPromiseResolveBlock)resolve
  rejecter:(RCTPromiseRejectBlock)reject
)

@end
