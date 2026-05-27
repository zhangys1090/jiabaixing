export enum UIAControlType {
  Button = 50000,
  Calendar = 50001,
  CheckBox = 50002,
  ComboBox = 50003,
  Edit = 50004,
  Hyperlink = 50005,
  Image = 50006,
  ListItem = 50007,
  List = 50008,
  Menu = 50009,
  MenuBar = 50010,
  MenuItem = 50011,
  ProgressBar = 50012,
  RadioButton = 50013,
  ScrollBar = 50014,
  Slider = 50015,
  Spinner = 50016,
  StatusBar = 50017,
  Tab = 50018,
  TabItem = 50019,
  Text = 50020,
  ToolBar = 50021,
  ToolTip = 50022,
  Tree = 50023,
  TreeItem = 50024,
  Custom = 50025,
  Group = 50026,
  Thumb = 50027,
  DataGrid = 50028,
  DataItem = 50029,
  Document = 50030,
  SplitButton = 50031,
  Window = 50032,
  Pane = 50033,
  Header = 50034,
  HeaderItem = 50035,
  Table = 50036,
  TitleBar = 50037,
  Separator = 50038,
}

export const CONTROL_TYPE_NAMES: Record<number, string> = {
  [UIAControlType.Button]: 'Button',
  [UIAControlType.Edit]: 'Edit',
  [UIAControlType.Text]: 'Text',
  [UIAControlType.Hyperlink]: 'Hyperlink',
  [UIAControlType.List]: 'List',
  [UIAControlType.ListItem]: 'ListItem',
  [UIAControlType.Menu]: 'Menu',
  [UIAControlType.MenuItem]: 'MenuItem',
  [UIAControlType.ComboBox]: 'ComboBox',
  [UIAControlType.CheckBox]: 'CheckBox',
  [UIAControlType.RadioButton]: 'RadioButton',
  [UIAControlType.Tab]: 'Tab',
  [UIAControlType.TabItem]: 'TabItem',
  [UIAControlType.Tree]: 'Tree',
  [UIAControlType.TreeItem]: 'TreeItem',
  [UIAControlType.Window]: 'Window',
  [UIAControlType.Pane]: 'Pane',
  [UIAControlType.Group]: 'Group',
  [UIAControlType.ToolBar]: 'ToolBar',
  [UIAControlType.StatusBar]: 'StatusBar',
  [UIAControlType.ProgressBar]: 'ProgressBar',
  [UIAControlType.Slider]: 'Slider',
  [UIAControlType.Spinner]: 'Spinner',
  [UIAControlType.Calendar]: 'Calendar',
  [UIAControlType.DataGrid]: 'DataGrid',
  [UIAControlType.DataItem]: 'DataItem',
  [UIAControlType.Document]: 'Document',
  [UIAControlType.SplitButton]: 'SplitButton',
  [UIAControlType.Header]: 'Header',
  [UIAControlType.HeaderItem]: 'HeaderItem',
  [UIAControlType.Table]: 'Table',
  [UIAControlType.TitleBar]: 'TitleBar',
  [UIAControlType.Separator]: 'Separator',
  [UIAControlType.Image]: 'Image',
  [UIAControlType.Custom]: 'Custom',
  [UIAControlType.Thumb]: 'Thumb',
  [UIAControlType.ScrollBar]: 'ScrollBar',
  [UIAControlType.ToolTip]: 'ToolTip',
};

export interface UIElement {
  name: string;
  automationId: string;
  controlType: number;
  controlTypeName: string;
  className: string;
  processName: string;
  windowTitle: string;
  boundingRect: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  center: {
    x: number;
    y: number;
  };
  isClickable: boolean;
  isEditable: boolean;
  isVisible: boolean;
  isEnabled: boolean;
  hasKeyboardFocus: boolean;
  helpText: string;
  depth: number;
  path: string;
  childCount: number;
}

export interface UIElementNode extends UIElement {
  children: UIElementNode[];
}

export interface ElementQueryResult {
  success: boolean;
  elements: UIElement[];
  matchedBy: 'name' | 'automationId' | 'controlType' | 'path' | 'partial';
  query: string;
  error?: string;
}

export interface UIInspectorConfig {
  maxDepth?: number;
  includeInvisible?: boolean;
  minSize?: number;
  timeoutMs?: number;
}
