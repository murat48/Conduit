'use client';

import React from 'react';
import { Card } from '@/components/ui/card';

interface PriceDisplayProps {
  price: number;
  lastUpdate: Date | null;
  isTracking: boolean;
}

export const PriceDisplay: React.FC<PriceDisplayProps> = ({
  price,
  lastUpdate,
  isTracking
}) => {
  const formatPrice = (price: number): string => {
    return price > 0 ? `$${price.toFixed(4)}` : 'Loading...';
  };

  const formatTime = (date: Date | null): string => {
    if (!date) return 'Not Updated Yet';
    return date.toLocaleTimeString('en-US');
  };

  return (
    <Card className="text-center bg-gradient-to-br from-blue-50 to-purple-50 border-2 border-blue-200">
      <div className="space-y-4">
        <div className="flex items-center justify-center gap-2">
          <span className="text-2xl">🌟</span>
          <h2 className="text-2xl font-bold text-gray-800">XLM Price</h2>
        </div>
        
        <div className="text-center">
          <div className="text-4xl font-bold text-blue-600 mb-2">
            {formatPrice(price)}
          </div>
          <div className="text-sm text-gray-600">
            Against USDC
          </div>
        </div>

        <div className="flex items-center justify-center gap-3 text-sm">
          <div className={`flex items-center gap-1 ${isTracking ? 'text-green-600' : 'text-gray-500'}`}>
            <span>{isTracking ? '🟢' : '⚪'}</span>
            <span>{isTracking ? 'Tracking Active' : 'Tracking Stopped'}</span>
          </div>
          
          <div className="text-gray-500">
            Last Update: {formatTime(lastUpdate)}
          </div>
        </div>
      </div>
    </Card>
  );
};