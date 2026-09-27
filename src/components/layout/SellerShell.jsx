import { useEffect, useRef } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from './Sidebar.jsx';
import TopBar from './TopBar.jsx';
import BottomTabBar from './BottomTabBar.jsx';

// The dashboard's frame. The window never scrolls; the content area does
// (.app-shell / .app-scroll in index.css), so the sidebar and top bar stay put
// on every device, including an iPad, whose page bounce used to drag them.
export default function SellerShell() {
  const main = useRef(null);
  const { pathname } = useLocation();

  // The content area outlives the pages inside it, so a new page would open
  // at the last one's scroll position without this.
  useEffect(() => {
    main.current?.scrollTo(0, 0);
  }, [pathname]);

  return (
    <div className="app-shell bg-bg">
      <Sidebar />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <TopBar />
        {/* The bottom padding clears the tab bar on phones, where it is fixed
            over the content. */}
        <main ref={main} className="app-scroll px-4 pb-24 pt-5 md:px-6 lg:pb-8">
          <Outlet />
        </main>
      </div>

      <BottomTabBar />
    </div>
  );
}
