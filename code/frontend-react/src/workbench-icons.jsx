import React from 'react';

const paths = {
  arrow: 'M5 12h14m-5-5 5 5-5 5',
  refresh: 'M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 13 2M5 16a8 8 0 0 0 13 2',
  dailyPending: 'M21 12a9 9 0 1 1-9-9M12 7v5l3 2',
  dailyDone: 'M21 11v1a9 9 0 1 1-5.3-8.2m-6.7 7.2 3 3L22 4',
  list: 'M9 6h12M9 12h12M9 18h12M3 6h1M3 12h1M3 18h1',
  star: 'm12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 18 6.4 21l1.1-6.2L3 10.4l6.2-.9L12 3Z',
  watch: 'm12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3Z',
  history: 'M3 11a9 9 0 1 1 2.5 7M3 4v7h7m2-4v5l3 2',
  link: 'm10 13 4-4m-5 6-2 2a3 3 0 0 1-4-4l4-4a3 3 0 0 1 4 0m2 0 2-2a3 3 0 0 1 4 4l-4 4a3 3 0 0 1-4 0',
};

export function WorkbenchIcon({ name }) {
  return <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
    {name === 'calendar' ? <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M7 3v4m10-4v4M3 11h18" /></>
      : name === 'check' ? <><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></>
        : <path d={paths[name]} />}
  </svg>;
}
