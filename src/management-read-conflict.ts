export class ManagementReadConflict extends Error {
  constructor() { super("Management records changed during read-only inspection"); }
}
