export const formatAmount = (amount: string, decimals: number = 7): string => {
  return (parseInt(amount) / Math.pow(10, decimals)).toFixed(decimals);
};

export const formatAddress = (address: string): string => {
  return `${address.substring(0, 8)}...${address.substring(address.length - 8)}`;
};

export const formatPercentage = (value: string): string => {
  const num = parseFloat(value);
  return `${num.toFixed(2)}%`;
};

export const cn = (...classes: string[]) => {
  return classes.filter(Boolean).join(' ');
};