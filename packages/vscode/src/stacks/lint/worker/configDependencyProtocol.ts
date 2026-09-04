export const CONFIG_DEPENDENCY_STATUS_NOTIFICATION =
  'rstack/rslintConfigDependency';

export interface ConfigDependencyFailure {
  readonly configPath: string;
  readonly cause: string;
}

export interface ConfigDependencyStatusNotification {
  readonly failure: ConfigDependencyFailure | null;
}
