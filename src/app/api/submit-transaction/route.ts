import { NextRequest, NextResponse } from 'next/server';
import * as StellarSdk from '@stellar/stellar-sdk';

export async function POST(request: NextRequest) {
  console.log('🚀 API /submit-transaction called');
  
  try {
    const body = await request.json();
    console.log('📥 Request body received:', body);
    
    const { xdr } = body;
    
    if (!xdr) {
      console.log('❌ XDR missing in request');
      return NextResponse.json(
        { success: false, error: 'XDR is required' },
        { status: 400 }
      );
    }

    console.log('📤 Submitting transaction to Stellar network...');
    console.log('XDR type:', typeof xdr);
    console.log('XDR length:', xdr.length);
    console.log('XDR preview:', xdr.substring(0, 100) + '...');

    // Stellar Horizon server
    const server = new StellarSdk.Horizon.Server('https://horizon-testnet.stellar.org');

    // Rebuild the transaction from the XDR
    const transaction = StellarSdk.TransactionBuilder.fromXDR(xdr, 'https://horizon-testnet.stellar.org');
    
    // Submit the transaction to the Stellar network
    console.log('🚀 Submitting to Stellar network...');
    try {
      const result = await server.submitTransaction(transaction);
      
      console.log('✅ Transaction submitted successfully');
      console.log('Hash:', result.hash);
      console.log('Ledger:', result.ledger);
      
      const successResponse = {
        success: true,
        hash: result.hash,
        ledger: result.ledger,
        message: `Transaction submitted successfully. Hash: ${result.hash}`
      };
      
      console.log('📤 Sending success response:', successResponse);
      return NextResponse.json(successResponse);
    } catch (stellarSubmitError: unknown) {
      console.error('❌ Stellar network submission failed:', stellarSubmitError);
      
      // Handle Stellar submit errors explicitly
      if (stellarSubmitError && typeof stellarSubmitError === 'object' && 'response' in stellarSubmitError) {
        const stellarError = stellarSubmitError as { 
          response?: { 
            data?: { 
              title?: string; 
              detail?: string;
              extras?: Record<string, unknown>;
              [key: string]: unknown 
            } 
          } 
        };
        
        if (stellarError.response && stellarError.response.data) {
          console.error('🔍 Stellar error details:', JSON.stringify(stellarError.response.data, null, 2));
          
          const errorResponse = { 
            success: false, 
            error: stellarError.response.data.title || stellarError.response.data.detail || 'Stellar network error',
            details: stellarError.response.data,
            stellarError: true
          };
          
          console.log('📤 Sending Stellar network error response:', errorResponse);
          return NextResponse.json(errorResponse, { status: 400 });
        }
      }
      
      // Generic Stellar error
      const genericStellarError = { 
        success: false, 
        error: stellarSubmitError instanceof Error ? stellarSubmitError.message : 'Stellar network submission failed',
        stellarError: true
      };
      
      console.log('📤 Sending generic Stellar error response:', genericStellarError);
      return NextResponse.json(genericStellarError, { status: 500 });
    }

  } catch (error: unknown) {
    console.error('❌ Transaction submission failed:', error);
    console.error('❌ Error type:', typeof error);
    console.error('❌ Error name:', error instanceof Error ? error.name : 'Unknown');
    console.error('❌ Error message:', error instanceof Error ? error.message : 'Unknown');
    
    // Stellar SDK errors often have specific structures
    if (error && typeof error === 'object' && 'response' in error) {
      const stellarError = error as { response?: { data?: { title?: string; [key: string]: unknown } } };
      if (stellarError.response && stellarError.response.data) {
        console.error('Stellar error details:', stellarError.response.data);
        
        const errorResponse = { 
          success: false, 
          error: stellarError.response.data.title || (error instanceof Error ? error.message : 'Unknown error'),
          details: stellarError.response.data
        };
        
        console.log('📤 Sending Stellar error response:', errorResponse);
        return NextResponse.json(errorResponse, { status: 400 });
      }
    }
    
    const genericErrorResponse = { 
      success: false, 
      error: error instanceof Error ? error.message : 'Transaction submission failed'
    };
    
    console.log('📤 Sending generic error response:', genericErrorResponse);
    return NextResponse.json(genericErrorResponse, { status: 500 });
  }
}
