import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar.jsx';
import TopBar from './TopBar.jsx';
import BottomTabBar from './BottomTabBar.jsx';

export default function SellerShell() {
  return (
    <div className="flex min-h-dvh bg-bg">
      <Sidebar />

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        {/* The bottom padding clears the tab bar on phones, where it is fixed
            over the content. */}
        <main className="flex-1 px-4 pb-24 pt-5 md:px-6 lg:pb-8">
          <Outlet />
        </main>
      </div>

      <BottomTabBar />
    </div>
  );
}
