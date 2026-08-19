/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import FeatureNodeGrid, { FEATURE_NODES, FeatureNode } from './FeatureNodeGrid';

describe('FeatureNodeGrid', () => {
  test('renders all feature nodes', () => {
    const handleClick = jest.fn();
    render(<FeatureNodeGrid onNodeClick={handleClick} />);

    FEATURE_NODES.forEach((node) => {
      expect(screen.getByText(node.label)).toBeInTheDocument();
      expect(screen.getByText(node.description)).toBeInTheDocument();
    });
  });

  test('calls onNodeClick with correct node when card is clicked', () => {
    const handleClick = jest.fn();
    render(<FeatureNodeGrid onNodeClick={handleClick} />);

    const firstNode = FEATURE_NODES[0];
    const card = screen.getByRole('button', { name: `${firstNode.label}: ${firstNode.description}` });
    fireEvent.click(card);

    expect(handleClick).toHaveBeenCalledTimes(1);
    expect(handleClick).toHaveBeenCalledWith(firstNode);
  });

  test('each card has accessible label and description', () => {
    const handleClick = jest.fn();
    render(<FeatureNodeGrid onNodeClick={handleClick} />);

    const cards = screen.getAllByRole('listitem');
    expect(cards).toHaveLength(FEATURE_NODES.length);

    cards.forEach((card, index) => {
      const node = FEATURE_NODES[index];
      const button = card.querySelector('button');
      expect(button).toHaveAttribute('aria-label', `${node.label}: ${node.description}`);
    });
  });
});
