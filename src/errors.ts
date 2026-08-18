/** Base error for cassette configuration, format, and replay failures. */
export class CassetteError extends Error {
  readonly code: string

  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CassetteError'
    this.code = code
  }
}

/** Raised when a cassette is malformed, partially written, or fails its hash chain. */
export class CassetteFormatError extends CassetteError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'CASSETTE_FORMAT', options)
    this.name = 'CassetteFormatError'
  }
}

/** Raised when a live call cannot be matched without guessing. */
export class CassetteMismatchError extends CassetteError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'CASSETTE_MISMATCH', options)
    this.name = 'CassetteMismatchError'
  }
}

/** Raised when multiple roots or duplicate interactions have no stable key. */
export class CassetteAmbiguityError extends CassetteError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'CASSETTE_AMBIGUOUS', options)
    this.name = 'CassetteAmbiguityError'
  }
}

/** Error reconstructed from an interaction that failed before publication. */
export class CassetteRecordedError extends CassetteError {
  readonly recordedName: string

  constructor(message: string, recordedName: string, recordedCode?: string) {
    super(message, recordedCode ?? 'CASSETTE_RECORDED_ERROR')
    this.name = 'CassetteRecordedError'
    this.recordedName = recordedName
  }
}
