export class JdcPrivacyEngineError extends Error {
  readonly code = "privacy_engine_failure";

  constructor(message = "Privacy Shield engine failed") {
    super(message);
    this.name = "JdcPrivacyEngineError";
  }
}
