export interface AppSettingTable {
  key: string;
  value_json: string;
  updated_at: string;
  updated_by: number | null;
}

export interface SettingsTables {
  app_setting: AppSettingTable;
}
