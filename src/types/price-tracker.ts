export interface PriceAlert {
  id: string;
  targetPrice: number;
  condition: 'above' | 'below';
  isActive: boolean;
  createdAt: Date;
  triggeredAt?: Date;
}

export interface PriceData {
  price: number;
  timestamp: Date;
  change24h?: number;
  volume24h?: number;
}

export interface NotificationSettings {
  email?: string;
  telegram?: string;
  discord?: string;
  sound: boolean;
  browser: boolean;
}

