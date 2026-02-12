import React from 'react';
import { Box, Text } from 'ink';
import type { OrderbookSide } from '../hooks/use-market-data.js';
import Decimal from 'decimal.js';

interface PricePanelProps {
  upAsk: OrderbookSide;
  upBid: OrderbookSide;
  downAsk: OrderbookSide;
  downBid: OrderbookSide;
  sum: Decimal | null;
}

export const PricePanel: React.FC<PricePanelProps> = ({ upAsk, upBid, downAsk, downBid, sum }) => {
  const fmtPrice = (d: Decimal | null) => d ? `$${d.toFixed(2)}` : ' -.--';
  const fmtSize = (s: number) => s > 0 ? String(Math.round(s)) : '-';

  const sumColor = sum
    ? sum.lessThan(1) ? 'green' : sum.equals(1) ? 'yellow' : 'red'
    : 'gray';

  return (
    <Box borderStyle="single" borderColor="blue" flexDirection="column" paddingX={1}>
      <Text bold underline>Orderbook</Text>
      <Text>       {'  '}  <Text bold>Bid</Text>          <Text bold>Ask</Text></Text>
      <Text color="green">
        {'  UP   '}
        {fmtPrice(upBid.price)}/{fmtSize(upBid.size)}
        {'   '}
        {fmtPrice(upAsk.price)}/{fmtSize(upAsk.size)}
      </Text>
      <Text color="red">
        {'  DOWN '}
        {fmtPrice(downBid.price)}/{fmtSize(downBid.size)}
        {'   '}
        {fmtPrice(downAsk.price)}/{fmtSize(downAsk.size)}
      </Text>
      <Text> </Text>
      <Text color={sumColor}>  SUM  {sum ? `$${sum.toFixed(4)}` : '$-.----'}</Text>
    </Box>
  );
};
