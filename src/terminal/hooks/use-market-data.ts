import { useState, useEffect, useRef } from 'react';
import Decimal from 'decimal.js';
import type { EnhancedDipArbStrategy } from '../../strategy/enhanced-dip-arb.js';

export interface OrderbookSide {
  price: Decimal | null;
  size: number;
}

export interface MarketData {
  upAsk: OrderbookSide;
  upBid: OrderbookSide;
  downAsk: OrderbookSide;
  downBid: OrderbookSide;
  sum: Decimal | null;
  currentMarket: string | null;
  secondsRemaining: number | null;
}

export function useMarketData(strategy: EnhancedDipArbStrategy): MarketData {
  const [upAsk, setUpAsk] = useState<OrderbookSide>({ price: null, size: 0 });
  const [upBid, setUpBid] = useState<OrderbookSide>({ price: null, size: 0 });
  const [downAsk, setDownAsk] = useState<OrderbookSide>({ price: null, size: 0 });
  const [downBid, setDownBid] = useState<OrderbookSide>({ price: null, size: 0 });
  const [currentMarket, setCurrentMarket] = useState<string | null>(null);
  const [secondsRemaining, setSecondsRemaining] = useState<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const handlePrice = (data: {
      upAsk: number; upAskSize: number; upBid: number; upBidSize: number;
      downAsk: number; downAskSize: number; downBid: number; downBidSize: number;
    }) => {
      setUpAsk({ price: new Decimal(data.upAsk), size: data.upAskSize });
      setUpBid({ price: data.upBid > 0 ? new Decimal(data.upBid) : null, size: data.upBidSize });
      setDownAsk({ price: new Decimal(data.downAsk), size: data.downAskSize });
      setDownBid({ price: data.downBid > 0 ? new Decimal(data.downBid) : null, size: data.downBidSize });
    };

    const handleNewRound = (data: { slug: string; secondsRemaining: number }) => {
      setCurrentMarket(data.slug);
      setSecondsRemaining(data.secondsRemaining);
    };

    strategy.on('priceUpdate', handlePrice);
    strategy.on('newRound', handleNewRound);

    // Countdown timer
    timerRef.current = setInterval(() => {
      setSecondsRemaining(prev => (prev != null && prev > 0 ? prev - 1 : prev));
    }, 1000);

    return () => {
      strategy.off('priceUpdate', handlePrice);
      strategy.off('newRound', handleNewRound);
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [strategy]);

  const sum = upAsk.price && downAsk.price ? upAsk.price.plus(downAsk.price) : null;

  return { upAsk, upBid, downAsk, downBid, sum, currentMarket, secondsRemaining };
}
