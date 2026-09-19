
import { PriceAlert, PriceData } from '@/types/price-tracker';
import { getReflectorXlmPrice } from './reflector';
// import { soroswapAPI } from './api';
// import { ASSET_OPTIONS } from './constants';

export class PriceTracker {
  private alerts: PriceAlert[] = [];
  private currentPrice: number = 0; // Mainnet fiyatı
  private intervalId: NodeJS.Timeout | null = null;
  private listeners: ((price: PriceData) => void)[] = [];

  constructor() {
    this.loadAlertsFromStorage();
  }

  // Fiyat takibini başlat
  startTracking(intervalMs: number = 30000) {
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }

    this.intervalId = setInterval(async () => {
      try {
        await this.fetchCurrentPrice(); // Sadece mainnet
        this.checkAlerts();
      } catch (error) {
        console.error('Fiyat takip hatası:', error);
      }
    }, intervalMs);

    // İlk fiyatı hemen al
    this.fetchCurrentPrice();
  }

  // Fiyat takibini durdur
  stopTracking() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  // 🌐 Fiyatı al: Reflector oracle (testnet, on-chain) → CoinGecko → Soroswap mainnet
  private async fetchCurrentPrice(): Promise<void> {
    try {
      console.log('🔮 Fetching XLM price from Reflector oracle...');
      this.currentPrice = await getReflectorXlmPrice();
      console.log('🔮 XLM fiyatı (Reflector):', this.currentPrice);

      const priceData: PriceData = {
        price: this.currentPrice,
        timestamp: new Date()
      };
      this.listeners.forEach(listener => listener(priceData));
    } catch (reflectorError) {
      console.error('Reflector fiyat alma hatası, CoinGecko\'ya düşülüyor:', reflectorError);
      await this.fetchCurrentPriceFromCoinGecko();
    }
  }

  private async fetchCurrentPriceFromCoinGecko(): Promise<void> {
    try {
      // Önce CoinGecko'dan gerçek fiyatı al
      console.log('🌐 Fetching XLM price from CoinGecko...');

      const response = await fetch(
        'https://api.coingecko.com/api/v3/simple/price?ids=stellar&vs_currencies=usd',
        {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
          },
          mode: 'cors',
        }
      );

      console.log('📡 CoinGecko response status:', response.status);

      if (!response.ok) {
        throw new Error(`CoinGecko API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      console.log('📊 CoinGecko response data:', data);
      
      if (!data.stellar || typeof data.stellar.usd !== 'number') {
        throw new Error('Invalid price data from CoinGecko');
      }
      this.currentPrice = data.stellar.usd;

      console.log('🌐 Mainnet XLM fiyatı (CoinGecko):', this.currentPrice);

      // Listeners'ları bilgilendir
      const priceData: PriceData = {
        price: this.currentPrice,
        timestamp: new Date()
      };
      this.listeners.forEach(listener => listener(priceData));

    } catch (error) {
      console.error('CoinGecko fiyat alma hatası:', error);
      // Hata durumunda Soroswap mainnet'i dene
      try {
        await this.fetchMainPriceFromSoroswap();
      } catch (fallbackError) {
        console.error('Soroswap fallback hatası:', fallbackError);
        throw fallbackError;
      }
    }
  }

  // 🏪 Soroswap Mainnet'ten fiyat al (fallback)
  private async fetchMainPriceFromSoroswap(): Promise<void> {
    // Mainnet asset adresleri
    const MAINNET_XLM = 'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA';
    const MAINNET_USDC = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75';

    // Mainnet API çağrısı
    const mainnetResponse = await fetch(`https://api.soroswap.finance/quote?network=mainnet`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.NEXT_PUBLIC_SOROSWAP_API_KEY || 'your-api-key'}`,
      },
      body: JSON.stringify({
        assetIn: MAINNET_XLM,
        assetOut: MAINNET_USDC,
        amount: '10000000',
        tradeType: 'EXACT_IN',
        protocols: ['soroswap', 'phoenix', 'aqua', 'sdex'],
        slippageTolerance: 50
      })
    });

    if (!mainnetResponse.ok) {
      throw new Error(`Mainnet API error: ${mainnetResponse.status}`);
    }

    const quote = await mainnetResponse.json();
    this.currentPrice = parseFloat(quote.amountOut) / Math.pow(10, 7);

    console.log('🏪 Mainnet XLM fiyatı (Soroswap):', this.currentPrice);

    // Listeners'ları bilgilendir
    const priceData: PriceData = {
      price: this.currentPrice,
      timestamp: new Date()
    };
    this.listeners.forEach(listener => listener(priceData));
  }

  // Alert kontrol
  private checkAlerts(): void {
    this.alerts.forEach(alert => {
      if (!alert.isActive || alert.triggeredAt) return;

      const shouldTrigger = 
        (alert.condition === 'above' && this.currentPrice >= alert.targetPrice) ||
        (alert.condition === 'below' && this.currentPrice <= alert.targetPrice);

      if (shouldTrigger) {
        this.triggerAlert(alert);
      }
    });
  }

  // Alert tetikleme
  private triggerAlert(alert: PriceAlert): void {
    alert.triggeredAt = new Date();
    alert.isActive = false;
    
    const message = `🚨 XLM Fiyat Uyarısı!\n` +
      `Hedef: $${alert.targetPrice}\n` +
      `Güncel: $${this.currentPrice.toFixed(4)} (Mainnet)\n` +
      `Durum: ${alert.condition === 'above' ? 'Yukarı' : 'Aşağı'} geçti`;

    // Browser notification
    this.showBrowserNotification(message);

    // Custom event trigger
    window.dispatchEvent(new CustomEvent('priceAlert', {
      detail: { alert, currentPrice: this.currentPrice, message, source: 'Mainnet' }
    }));

    this.saveAlertsToStorage();
  }

  // Browser notification göster
  private showBrowserNotification(message: string): void {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification('XLM Fiyat Uyarısı', {
        body: message,
        icon: '/next.svg' // Mevcut bir ikon kullanıyoruz
      });
    }
  }

  // Notification permission iste
  static async requestNotificationPermission(): Promise<boolean> {
    if ('Notification' in window) {
      const permission = await Notification.requestPermission();
      return permission === 'granted';
    }
    return false;
  }

  // LocalStorage'a kaydet
  private saveAlertsToStorage(): void {
    try {
      localStorage.setItem('xlm_price_alerts', JSON.stringify(this.alerts));
    } catch (error) {
      console.error('Alert kaydetme hatası:', error);
    }
  }

  // LocalStorage'dan yükle
  private loadAlertsFromStorage(): void {
    try {
      const stored = localStorage.getItem('xlm_price_alerts');
      if (stored) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.alerts = JSON.parse(stored).map((alert: any) => ({
          ...alert,
          createdAt: new Date(alert.createdAt),
          triggeredAt: alert.triggeredAt ? new Date(alert.triggeredAt) : undefined
        }));
      }
    } catch (error) {
      console.error('Alert yükleme hatası:', error);
    }
  }

  // Fiyat değişimi listener'ı ekle
  addPriceListener(callback: (price: PriceData) => void) {
    this.listeners.push(callback);
  }

  // Listener'ı kaldır
  removePriceListener(callback: (price: PriceData) => void) {
    this.listeners = this.listeners.filter(l => l !== callback);
  }

  // Yeni alert ekle
  addAlert(targetPrice: number, condition: 'above' | 'below'): string {
    const alert: PriceAlert = {
      id: Date.now().toString(),
      targetPrice,
      condition,
      isActive: true,
      createdAt: new Date()
    };

    this.alerts.push(alert);
    this.saveAlertsToStorage();
    return alert.id;
  }

  // Alert'i kaldır
  removeAlert(alertId: string): boolean {
    const initialLength = this.alerts.length;
    this.alerts = this.alerts.filter(alert => alert.id !== alertId);
    this.saveAlertsToStorage();
    return this.alerts.length < initialLength;
  }

  // Getter'lar
  getCurrentPrice(): number {
    return this.currentPrice; // Mainnet fiyatı
  }

  getAlerts(): PriceAlert[] {
    return this.alerts;
  }

  getActiveAlerts(): PriceAlert[] {
    return this.alerts.filter(alert => alert.isActive);
  }
}

export const priceTracker = new PriceTracker();