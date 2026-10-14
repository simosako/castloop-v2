export class PublicationValidationFailure extends Error {
  constructor() { super("Stored publication inputs could not be validated."); }
}

export function parsePublicationInput<T>(parse: () => T): T {
  try { return parse(); }
  catch { throw new PublicationValidationFailure(); }
}
