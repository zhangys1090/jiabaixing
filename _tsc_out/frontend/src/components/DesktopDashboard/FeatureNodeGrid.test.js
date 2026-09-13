"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const jsx_runtime_1 = require("react/jsx-runtime");
/**
 * @jest-environment jsdom
 */
const react_1 = require("@testing-library/react");
const FeatureNodeGrid_1 = __importStar(require("./FeatureNodeGrid"));
describe('FeatureNodeGrid', () => {
    test('renders all feature nodes', () => {
        const handleClick = jest.fn();
        (0, react_1.render)((0, jsx_runtime_1.jsx)(FeatureNodeGrid_1.default, { onNodeClick: handleClick }));
        FeatureNodeGrid_1.FEATURE_NODES.forEach((node) => {
            expect(react_1.screen.getByText(node.label)).toBeInTheDocument();
            expect(react_1.screen.getByText(node.description)).toBeInTheDocument();
        });
    });
    test('calls onNodeClick with correct node when card is clicked', () => {
        const handleClick = jest.fn();
        (0, react_1.render)((0, jsx_runtime_1.jsx)(FeatureNodeGrid_1.default, { onNodeClick: handleClick }));
        const firstNode = FeatureNodeGrid_1.FEATURE_NODES[0];
        const card = react_1.screen.getByRole('button', { name: `${firstNode.label}: ${firstNode.description}` });
        react_1.fireEvent.click(card);
        expect(handleClick).toHaveBeenCalledTimes(1);
        expect(handleClick).toHaveBeenCalledWith(firstNode);
    });
    test('each card has accessible label and description', () => {
        const handleClick = jest.fn();
        (0, react_1.render)((0, jsx_runtime_1.jsx)(FeatureNodeGrid_1.default, { onNodeClick: handleClick }));
        const cards = react_1.screen.getAllByRole('listitem');
        expect(cards).toHaveLength(FeatureNodeGrid_1.FEATURE_NODES.length);
        cards.forEach((card, index) => {
            const node = FeatureNodeGrid_1.FEATURE_NODES[index];
            const button = card.querySelector('button');
            expect(button).toHaveAttribute('aria-label', `${node.label}: ${node.description}`);
        });
    });
});
