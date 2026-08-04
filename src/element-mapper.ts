/**
 * QML → Angular Element Mapper
 *
 * Maps QML elements to Angular components using @mocha-framework/qml-ng registry.
 * Stays pure (no fs/path imports) for compatibility with Vite bundling.
 */

export interface AngularElementDef {
  /** HTML tag or Angular selector */
  tag: string;
  /** Import path for the Angular component */
  importPath?: string;
  /** Symbol name to import */
  importName?: string;
}

// Auto-generated from @mocha-framework/qml-ng registry component-map.json.
// Contains all public MochaDS QML components mapped to their qml-ng selectors.
const QML_NG_MAP: Record<string, string> = {
  Accordion: 'Accordion', AdaptiveStack: 'AdaptiveStack',
  AdvancedSelect: 'AdvancedSelect', AdvancedTextEditor: 'AdvancedTextEditor',
  AlertDialog: 'AlertDialog', AnimatedNumber: 'AnimatedNumber',
  AnimatedPresence: 'AnimatedPresence', AnimateList: 'AnimateList',
  ApplicationWindow: 'ApplicationWindow', Avatar: 'Avatar',
  Badge: 'Badge', BarChart: 'BarChart', Bounce: 'Bounce',
  Box: 'Box', Breadcrumb: 'Breadcrumb', ButtonGroup: 'ButtonGroup',
  ButtonGroupItem: 'ButtonGroupItem', Button: 'qml-button',
  Card: 'Card', ChartTooltip: 'ChartTooltip', Checkbox: 'Checkbox',
  ColorPicker: 'ColorPicker', ContextMenu: 'ContextMenu',
  CozyColorPicker: 'CozyColorPicker', CozyGrid: 'CozyGrid',
  CozyGridCol: 'CozyGridCol', CozyList: 'CozyList',
  CozySkeleton: 'CozySkeleton', DataGrid: 'DataGrid',
  DatePicker: 'DatePicker', Div: 'Div', Draggable: 'Draggable',
  Drawer: 'Drawer', Dropdown: 'Dropdown', DropZone: 'DropZone',
  DynamicForm: 'DynamicForm', EmptyState: 'EmptyState',
  FadeIn: 'FadeIn', FadeOut: 'FadeOut', Flip: 'Flip',
  Form: 'qml-form', FormController: 'FormController',
  FormField: 'FormField', GaugeChart: 'GaugeChart',
  GlowPulse: 'GlowPulse', H1: 'H1', H2: 'H2', H3: 'H3', H4: 'H4',
  HeroCarousel: 'HeroCarousel', HoverCard: 'HoverCard',
  HStack: 'HStack', Icon: 'qml-icon',
  InteractiveListCell: 'InteractiveListCell',
  ItemsPerPage: 'ItemsPerPage', LineChart: 'LineChart',
  MediaQuery: 'MediaQuery', MochaLogo: 'MochaLogo',
  MochaMap: 'MochaMap', Modal: 'Modal', NavigationBar: 'NavigationBar',
  NavigationItem: 'NavigationItem', P: 'P', Paginator: 'Paginator',
  Particles: 'Particles', PieChart: 'PieChart', PinInput: 'PinInput',
  Popover: 'Popover', ProgressBar: 'ProgressBar',
  RadarChart: 'RadarChart', RadioButton: 'RadioButton',
  RadioGroup: 'RadioGroup', RangeSelector: 'RangeSelector',
  Route: 'Route', Router: 'Router', RouterLink: 'RouterLink',
  Select: 'qml-select', SelectTree: 'SelectTree',
  Separator: 'Separator', Shell: 'Shell', Sidebar: 'Sidebar',
  SidebarFooter: 'SidebarFooter', SidebarHeader: 'SidebarHeader',
  SidebarItem: 'SidebarItem', SidebarSection: 'SidebarSection',
  SlideDown: 'SlideDown', SlideLeft: 'SlideLeft',
  SlideOutDown: 'SlideOutDown', SlideOutUp: 'SlideOutUp',
  SlideRight: 'SlideRight', SlideUp: 'SlideUp', Slider: 'Slider',
  SortableList: 'SortableList', Span: 'Span', Spin: 'Spin',
  SteppedProgress: 'SteppedProgress', Stepper: 'Stepper',
  Steps: 'Steps', StepsSlider: 'StepsSlider',
  StripedFill: 'StripedFill', Switch: 'Switch', Table: 'qml-table',
  Tabs: 'Tabs', Tag: 'Tag', Text: 'qml-text',
  TextEditor: 'TextEditor',
  TextField: 'qml-text-field', Tile: 'Tile', Toast: 'Toast',
  ToastManager: 'ToastManager', ToggleButton: 'ToggleButton',
  Tooltip: 'Tooltip', TreeTable: 'TreeTable', VStack: 'VStack',
  Window: 'Window', ZoomIn: 'ZoomIn',
};

// Fallback map for Qt Quick builtins not in qml-ng
const FALLBACK_MAP: Record<string, AngularElementDef> = {
  Image: { tag: 'img' }, Loader: { tag: 'div' },
  MouseArea: { tag: 'div' }, Flickable: { tag: 'div' },
  ScrollView: { tag: 'div' }, BorderImage: { tag: 'img' },
  AnimatedImage: { tag: 'img' }, Canvas: { tag: 'canvas' },
  Column: { tag: 'div' }, Item: { tag: 'div' },
  Rectangle: { tag: 'div' },
  Router: { tag: 'router-outlet' }, RouterLink: { tag: 'a' },
  Repeater: { tag: 'ng-container' }, Route: { tag: 'ng-container' },
};

export function getElementDef(tag: string): AngularElementDef | undefined {
  // Check qml-ng map first
  const qmlNgSelector = QML_NG_MAP[tag];
  if (qmlNgSelector) {
    return {
      tag: qmlNgSelector,
      importPath: '@mocha-framework/qml-ng',
      importName: tag,
    };
  }

  // Check fallback
  return FALLBACK_MAP[tag];
}

export function hasQmlNgComponent(tag: string): boolean {
  // Check fallback for qml-ng mapped items
  const fb = FALLBACK_MAP[tag];
  if (fb?.importPath === '@mocha-framework/qml-ng') return true;
  // Check main qml-ng map
  return tag in QML_NG_MAP;
}
