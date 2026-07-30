import { useEffect, useRef, useState } from 'react';
import { searchApi, type SearchResult } from '../api/searchApi';
import { useTranslation } from '../../../shared/i18n/LocaleProvider';

export function SearchBar() {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    clearTimeout(debounceRef.current);
    if (query.trim().length < 2) {
      setResults([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      const found = await searchApi.search(query);
      setResults(found);
    }, 300);
    return () => clearTimeout(debounceRef.current);
  }, [query]);

  return (
    <div className="relative w-64">
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => setIsOpen(true)}
        onBlur={() => setTimeout(() => setIsOpen(false), 150)}
        placeholder={t('search.placeholder')}
        className="w-full rounded-card border border-sand-200 bg-white px-3 py-1.5 text-sm text-ink"
      />
      {isOpen && query.trim().length >= 2 && (
        <div className="absolute z-10 mt-1 w-full rounded-card border border-sand-200 bg-white shadow-lg">
          {results.length === 0 ? (
            <p className="px-3 py-2 text-xs text-ink-soft">{t('search.noResults')}</p>
          ) : (
            results.map((result) => (
              <div key={`${result.type}-${result.id}`} className="border-b border-sand-100 px-3 py-2 last:border-0">
                <p className="text-sm text-ink">{result.title}</p>
                <p className="text-xs text-ink-soft">{result.subtitle}</p>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
