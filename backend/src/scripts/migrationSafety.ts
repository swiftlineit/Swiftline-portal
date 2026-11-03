export function assertNonProductionEnvironment(environment: string, operation: string) {
  if (environment === "production") {
    throw new Error(`${operation} is restricted to a non-production environment.`);
  }
}

export function assertExpectedDatabaseName(expectedDatabase: string, actualDatabase: string | undefined) {
  if (!expectedDatabase.trim() || !actualDatabase || actualDatabase !== expectedDatabase.trim()) {
    throw new Error("Connected database did not match the expected database name.");
  }
}
