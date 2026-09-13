"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CONTROL_TYPE_NAMES = exports.UIAControlType = void 0;
var UIAControlType;
(function (UIAControlType) {
    UIAControlType[UIAControlType["Button"] = 50000] = "Button";
    UIAControlType[UIAControlType["Calendar"] = 50001] = "Calendar";
    UIAControlType[UIAControlType["CheckBox"] = 50002] = "CheckBox";
    UIAControlType[UIAControlType["ComboBox"] = 50003] = "ComboBox";
    UIAControlType[UIAControlType["Edit"] = 50004] = "Edit";
    UIAControlType[UIAControlType["Hyperlink"] = 50005] = "Hyperlink";
    UIAControlType[UIAControlType["Image"] = 50006] = "Image";
    UIAControlType[UIAControlType["ListItem"] = 50007] = "ListItem";
    UIAControlType[UIAControlType["List"] = 50008] = "List";
    UIAControlType[UIAControlType["Menu"] = 50009] = "Menu";
    UIAControlType[UIAControlType["MenuBar"] = 50010] = "MenuBar";
    UIAControlType[UIAControlType["MenuItem"] = 50011] = "MenuItem";
    UIAControlType[UIAControlType["ProgressBar"] = 50012] = "ProgressBar";
    UIAControlType[UIAControlType["RadioButton"] = 50013] = "RadioButton";
    UIAControlType[UIAControlType["ScrollBar"] = 50014] = "ScrollBar";
    UIAControlType[UIAControlType["Slider"] = 50015] = "Slider";
    UIAControlType[UIAControlType["Spinner"] = 50016] = "Spinner";
    UIAControlType[UIAControlType["StatusBar"] = 50017] = "StatusBar";
    UIAControlType[UIAControlType["Tab"] = 50018] = "Tab";
    UIAControlType[UIAControlType["TabItem"] = 50019] = "TabItem";
    UIAControlType[UIAControlType["Text"] = 50020] = "Text";
    UIAControlType[UIAControlType["ToolBar"] = 50021] = "ToolBar";
    UIAControlType[UIAControlType["ToolTip"] = 50022] = "ToolTip";
    UIAControlType[UIAControlType["Tree"] = 50023] = "Tree";
    UIAControlType[UIAControlType["TreeItem"] = 50024] = "TreeItem";
    UIAControlType[UIAControlType["Custom"] = 50025] = "Custom";
    UIAControlType[UIAControlType["Group"] = 50026] = "Group";
    UIAControlType[UIAControlType["Thumb"] = 50027] = "Thumb";
    UIAControlType[UIAControlType["DataGrid"] = 50028] = "DataGrid";
    UIAControlType[UIAControlType["DataItem"] = 50029] = "DataItem";
    UIAControlType[UIAControlType["Document"] = 50030] = "Document";
    UIAControlType[UIAControlType["SplitButton"] = 50031] = "SplitButton";
    UIAControlType[UIAControlType["Window"] = 50032] = "Window";
    UIAControlType[UIAControlType["Pane"] = 50033] = "Pane";
    UIAControlType[UIAControlType["Header"] = 50034] = "Header";
    UIAControlType[UIAControlType["HeaderItem"] = 50035] = "HeaderItem";
    UIAControlType[UIAControlType["Table"] = 50036] = "Table";
    UIAControlType[UIAControlType["TitleBar"] = 50037] = "TitleBar";
    UIAControlType[UIAControlType["Separator"] = 50038] = "Separator";
})(UIAControlType || (exports.UIAControlType = UIAControlType = {}));
exports.CONTROL_TYPE_NAMES = {
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
