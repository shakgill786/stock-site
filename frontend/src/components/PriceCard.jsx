// frontend/src/components/PriceCard.jsx
export default function PriceCard({ quote }) {
    return (
      <div style={{
        border: '1px solid #ddd',
        borderRadius: 8,
        padding: '1rem',
        marginBottom: '1rem',
        maxWidth: 300
      }}>
        <h2>💰 Current Price for {quote.ticker}</h2>
        <p>Last Close: ${quote.last_close}</p>
        <p>
          {quote.ticker}: ${quote.current_price}{' '}
          {quote.change_pct >= 0 ? '🔺' : '🔻'} {Math.abs(quote.change_pct)}%
        </p>
      </div>
    );
  }
  