import {
  MockSpotlightRepository,
} from '../../../packages/api-client/src/spotlight/repository';

export * from '../../../packages/api-client/src/spotlight/mock-data';
export * from '../../../packages/api-client/src/spotlight/types';
export {
  MockSpotlightRepository,
  SpotlightRepositoryRequestError,
  isSpotlightRepositoryRequestError,
} from '../../../packages/api-client/src/spotlight/repository';
export type { SpotlightRepository } from '../../../packages/api-client/src/spotlight/repository';

export class HttpSpotlightRepository extends MockSpotlightRepository {
  constructor(_baseUrl: string) {
    super();
  }
}
