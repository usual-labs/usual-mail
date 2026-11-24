// @usualmail/server: the service over a SQLite store, its REST surface and the seams a host fills in.

export { createApp, type RestOptions } from "./rest/app.ts";
export { MailServer, type AttachmentFile, type MailServerOptions } from "./service/server.ts";
export type { ServiceOptions } from "./service/context.ts";
export { ProviderRegistry } from "./providers.ts";
export { checkInterfaces, providerRegistry, type MountedInterface, type Parts } from "./parts.ts";
export { aesGcmSecrets, parseKey } from "./secrets.ts";
export {
  consoleLog,
  MemoryEventBus,
  systemClock,
  webRandom,
  type Clock,
  type EventBus,
  type Host,
  type Log,
  type PictureSource,
  type SiteIconSource,
  type Random,
  type Scheduler,
  type Secrets,
  type WebPicture,
} from "./host.ts";
export { PictureRefused } from "./pictures/refused.ts";
export type { Database } from "./db/index.ts";
export { DEMO_SUFFIXES, demoModels, demoProviders, seedSample, seedSamplePictures, type Demo } from "./demo/seed.ts";
export { FakeModels, failure, dataItems, type FakeRequest } from "./ai/fake.ts";
export { AiServiceError, type AiModelAccess, type AiModels, type ChoiceRequest, type TextRequest } from "./ai/models.ts";
export { DEFAULT_MODELS, sdkModelAccess, type SdkAccessOptions } from "./ai/sdk.ts";
export { SERVER_VERSION } from "./version.ts";
