import { useState, useEffect, useCallback } from 'react';
import { PriceAlert, PriceData } from '@/types/price-tracker';

// Lazy import - browser only
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let priceTrackerInstance: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let PriceTrackerClass: any = null;

const getPriceTracker = async () => {
  if (typeof window === 'undefined') {
    // Server-side'da mock return et
    return {
      getCurrentPrice: () => 0,
      getAlerts: () => [],
      getActiveAlerts: () => [],
      getTelegramChatId: () => '',
      setTelegramChatId: () => {},
      sendTestMessage: () => Promise.resolve(false),
      startTracking: () => {},
      stopTracking: () => {},
      addAlert: () => '',
      removeAlert: () => false,
      addPriceListener: () => {},
      removePriceListener: () => {},
      requestNotificationPermission: () => Promise.resolve(false)
    };
  }

  if (!priceTrackerInstance) {
    // Dynamic import sadece browser'da
    // eslint-disable-next-line @next/next/no-assign-module-variable
    const module = await import('@/lib/price-tracker');
    priceTrackerInstance = module.priceTracker;
    PriceTrackerClass = module.PriceTracker;
  }
  
  return priceTrackerInstance;
};

export const usePriceTracker = () => {
  const [currentPrice, setCurrentPrice] = useState<number>(0);
  const [alerts, setAlerts] = useState<PriceAlert[]>([]);
  const [isTracking, setIsTracking] = useState<boolean>(false);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  // Load the PriceTracker instance
  useEffect(() => {
    let mounted = true;

    const initializePriceTracker = async () => {
      try {
        const tracker = await getPriceTracker();
        
        if (!mounted) return;

        // Initial state'i set et
        setCurrentPrice(tracker.getCurrentPrice());
        setAlerts(tracker.getAlerts());
        setIsLoading(false);

        // Price listener ekle
        const handlePriceUpdate = (priceData: PriceData) => {
          if (!mounted) return;
          setCurrentPrice(priceData.price);
          setLastUpdate(priceData.timestamp);
          setError(null);
        };

        tracker.addPriceListener(handlePriceUpdate);

        // Price alert listener
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const handlePriceAlert = (event: CustomEvent) => {
          if (!mounted) return;
          setAlerts(tracker.getAlerts());
        };

        if (typeof window !== 'undefined') {
          window.addEventListener('priceAlert', handlePriceAlert as EventListener);
        }

        // Cleanup function return et
        return () => {
          tracker.removePriceListener(handlePriceUpdate);
          if (typeof window !== 'undefined') {
            window.removeEventListener('priceAlert', handlePriceAlert as EventListener);
          }
        };
      } catch (err) {
        if (mounted) {
          setError((err as Error).message);
          setIsLoading(false);
        }
      }
    };

    initializePriceTracker();

    return () => {
      mounted = false;
    };
  }, []);

  const startTracking = useCallback(async (intervalMs: number = 30000) => {
    try {
      console.log('🚀 Starting price tracking with interval:', intervalMs);
      const tracker = await getPriceTracker();
      
      // Notification permission iste
      if (PriceTrackerClass?.requestNotificationPermission) {
        console.log('🔔 Requesting notification permission...');
        await PriceTrackerClass.requestNotificationPermission();
      }
      
      console.log('📊 Calling tracker.startTracking...');
      tracker.startTracking(intervalMs);
      setIsTracking(true);
      setError(null);
      console.log('✅ Price tracking started successfully');
    } catch (err) {
      console.error('❌ Price tracking start failed:', err);
      setError(err instanceof Error ? err.message : 'Unknown error');
      setIsTracking(false);
    }
  }, []);

  const stopTracking = useCallback(async () => {
    try {
      const tracker = await getPriceTracker();
      tracker.stopTracking();
      setIsTracking(false);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const addAlert = useCallback(async (targetPrice: number, condition: 'above' | 'below'): Promise<string> => {
    try {
      const tracker = await getPriceTracker();
      const alertId = tracker.addAlert(targetPrice, condition);
      setAlerts(tracker.getAlerts());
      return alertId;
    } catch (err) {
      setError((err as Error).message);
      return '';
    }
  }, []);

  const removeAlert = useCallback(async (alertId: string): Promise<boolean> => {
    try {
      const tracker = await getPriceTracker();
      const success = tracker.removeAlert(alertId);
      setAlerts(tracker.getAlerts());
      return success;
    } catch (err) {
      setError((err as Error).message);
      return false;
    }
  }, []);

  // Telegram helpers
  const getTelegramChatId = useCallback(async (): Promise<string> => {
    try {
      const tracker = await getPriceTracker();
      return tracker.getTelegramChatId();
    } catch (error) {
      return '';
    }
  }, []);

  const setTelegramChatId = useCallback(async (chatId: string): Promise<void> => {
    try {
      const tracker = await getPriceTracker();
      tracker.setTelegramChatId(chatId);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const sendTestMessage = useCallback(async (): Promise<boolean> => {
    try {
      const tracker = await getPriceTracker();
      return await tracker.sendTestMessage();
    } catch (err) {
      setError((err as Error).message);
      return false;
    }
  }, []);

  return {
    currentPrice,
    alerts,
    isTracking,
    lastUpdate,
    error,
    isLoading,
    startTracking,
    stopTracking,
    addAlert,
    removeAlert,
    activeAlerts: alerts.filter(a => a.isActive),
    
    // Telegram functions
    getTelegramChatId,
    setTelegramChatId,
    sendTestMessage
  };
};