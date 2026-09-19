'use client';

import React from 'react';
import { cn } from '@/lib/utils';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'success' | 'error' | 'mrt' | 'mrt2'| 'mrt3';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
}

export const Button: React.FC<ButtonProps> = ({
  children,
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled,
  className,
  ...props
}) => {
  const baseClasses = 'font-medium rounded-lg transition-all duration-200 flex items-center justify-center gap-2 disabled:cursor-not-allowed';
  
  const variantClasses = {
    primary: 'bg-blue-500 hover:bg-blue-600 text-white disabled:bg-gray-400',
    secondary: 'bg-gray-200 hover:bg-gray-300 text-gray-800 disabled:bg-gray-100',
    success: 'bg-green-500 hover:bg-green-600 text-white disabled:bg-gray-400',
    error: 'bg-red-500 hover:bg-red-600 text-white disabled:bg-gray-400',
    mrt: 'bg-purple-400 text-gray-800 ring-1 ring-gray-300 hover:bg-gray-50 hover:ring-gray-400 shadow-sm active:scale-[0.98] active:shadow-inner disabled:bg-gray-100 disabled:text-gray-400 disabled:ring-gray-200 disabled:cursor-not-allowed',
     mrt2: 'bg-red-400 text-gray-800 ring-1 ring-gray-300 hover:bg-gray-50 hover:ring-gray-400 shadow-sm active:scale-[0.98] active:shadow-inner disabled:bg-gray-100 disabled:text-gray-400 disabled:ring-gray-200 disabled:cursor-not-allowed',

     mrt3: 'bg-red-400 from-red-600 to-purple-700 text-white ring-1 ring-gray-300 hover:from-red-700 hover:to-purple-800 hover:ring-gray-400 shadow-sm active:scale-[0.98] active:shadow-inner disabled:bg-gray-100 disabled:text-gray-400 disabled:ring-gray-200 disabled:cursor-not-allowed',
  };

  const sizeClasses = {
    sm: 'px-3 py-1.5 text-sm',
    md: 'px-4 py-2',
    lg: 'px-6 py-3 text-lg',
  };

  return (
    <button
      className={cn(baseClasses, variantClasses[variant], sizeClasses[size], className || '')}
      disabled={disabled || loading}
      {...props}
    >
      {loading && (
        <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-current" />
      )}
      {children}
    </button>
  );
};
export default Button;