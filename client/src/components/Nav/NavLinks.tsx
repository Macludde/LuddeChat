import { Menu, Transition } from '@headlessui/react';
import type { TConversation } from 'librechat-data-provider';
import { useGetStartupConfig, useGetUserBalance } from 'librechat-data-provider/react-query';
import { Download, FileText, PlusIcon } from 'lucide-react';
import { Fragment, memo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useRecoilState, useRecoilValue } from 'recoil';
import { GearIcon, LinkIcon } from '~/components';
import FilesView from '~/components/Chat/Input/Files/FilesView';
import SwishModal, { BalanceInSEK } from '~/components/Swish/SwishModal';
import { UserIcon } from '~/components/svg';
import { useLocalize } from '~/hooks';
import { useAuthContext } from '~/hooks/AuthContext';
import useAvatar from '~/hooks/Messages/useAvatar';
import store from '~/store';
import { cn } from '~/utils/';
import { ExportModal } from './ExportConversation';
import Logout from './Logout';
import NavLink from './NavLink';
import Settings from './Settings';

function NavLinks() {
  const localize = useLocalize();
  const location = useLocation();
  const { user, isAuthenticated } = useAuthContext();
  const { data: startupConfig } = useGetStartupConfig();
  const balanceQuery = useGetUserBalance({
    enabled: !!isAuthenticated && startupConfig?.checkBalance,
  });
  const [showExports, setShowExports] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showFiles, setShowFiles] = useRecoilState(store.showFiles);

  const [showPayment, setShowPayment] = useState(false);

  const activeConvo = useRecoilValue(store.conversationByIndex(0));
  const globalConvo = useRecoilValue(store.conversation) ?? ({} as TConversation);

  const avatarSrc = useAvatar(user);

  let conversation: TConversation | null | undefined;
  if (location.state?.from?.pathname.includes('/chat')) {
    conversation = globalConvo;
  } else {
    conversation = activeConvo;
  }

  const exportable =
    conversation &&
    conversation.conversationId &&
    conversation.conversationId !== 'new' &&
    conversation.conversationId !== 'search';

  const clickHandler = () => {
    if (exportable) {
      setShowExports(true);
    }
  };

  return (
    <>
      <Menu as="div" className="group relative">
        {({ open }) => (
          <>
            {startupConfig?.checkBalance && (
              <>
                <Menu.Button
                  className="m-1 ml-3 flex items-center whitespace-nowrap text-left text-sm text-black dark:text-gray-200"
                  onClick={(e) => {
                    e.preventDefault();
                    setShowPayment(true);
                  }}
                >
                  Balans (<BalanceInSEK credits={Number.parseFloat(balanceQuery.data ?? '0')} />){' '}
                  <PlusIcon />
                </Menu.Button>
                <SwishModal
                  open={showPayment}
                  onOpenChange={setShowPayment}
                  currentBalance={Number.parseFloat(balanceQuery.data ?? '0')}
                />
              </>
            )}
            <Menu.Button
              className={cn(
                'group-ui-open:bg-gray-100 dark:group-ui-open:bg-gray-700 duration-350 mt-text-sm mb-1 flex h-11 w-full items-center gap-2 rounded-lg px-3 py-3 text-sm transition-colors hover:bg-gray-100 dark:hover:bg-gray-700',
                open ? 'bg-gray-100 dark:bg-gray-700' : '',
              )}
              data-testid="nav-user"
            >
              <div className="-ml-0.9 -mt-0.8 h-8 w-8 flex-shrink-0">
                <div className="relative flex">
                  {!user?.avatar && !user?.username ? (
                    <div
                      style={{
                        backgroundColor: 'rgb(121, 137, 255)',
                        width: '20px',
                        height: '20px',
                        boxShadow: 'rgba(240, 246, 252, 0.1) 0px 0px 0px 1px',
                      }}
                      className="relative flex h-8 w-8 items-center justify-center rounded-full p-1 text-white"
                    >
                      <UserIcon />
                    </div>
                  ) : (
                    <img className="rounded-full" src={user?.avatar || avatarSrc} alt="avatar" />
                  )}
                </div>
              </div>
              <div
                className="mt-2 grow overflow-hidden text-ellipsis whitespace-nowrap text-left text-black dark:text-white"
                style={{ marginTop: '0', marginLeft: '0' }}
              >
                {user?.name || localize('com_nav_user')}
              </div>
            </Menu.Button>

            <Transition
              as={Fragment}
              enter="transition ease-out duration-110 transform"
              enterFrom="translate-y-2 opacity-0"
              enterTo="translate-y-0 opacity-100"
              leave="transition ease-in duration-100 transform"
              leaveFrom="translate-y-0 opacity-100"
              leaveTo="translate-y-2 opacity-0"
            >
              <Menu.Items className="absolute bottom-full left-0 z-20 mb-1 mt-1 w-full translate-y-0 overflow-hidden rounded-lg bg-white py-1.5 opacity-100 outline-none dark:bg-gray-800">
                <Menu.Item as="div">
                  <NavLink
                    className={cn(
                      'flex w-full cursor-pointer items-center gap-3 rounded-none px-3 py-3 text-sm text-black transition-colors duration-200 hover:bg-gray-100 dark:text-white dark:hover:bg-gray-700',
                      exportable
                        ? 'cursor-pointer text-black dark:text-white'
                        : 'cursor-not-allowed text-black/50 dark:text-white/50',
                    )}
                    svg={() => <Download size={16} />}
                    text={localize('com_nav_export_conversation')}
                    clickHandler={clickHandler}
                  />
                </Menu.Item>
                <div className="my-1 h-px bg-black/20 dark:bg-white/20" role="none" />
                <Menu.Item as="div">
                  <NavLink
                    className="flex w-full cursor-pointer items-center gap-3 rounded-none px-3 py-3 text-sm text-black transition-colors duration-200 hover:bg-gray-100 dark:text-white dark:hover:bg-gray-700"
                    svg={() => <FileText className="icon-md" />}
                    text={localize('com_nav_my_files')}
                    clickHandler={() => setShowFiles(true)}
                  />
                </Menu.Item>
                {startupConfig?.helpAndFaqURL !== '/' && (
                  <Menu.Item as="div">
                    <NavLink
                      className="flex w-full cursor-pointer items-center gap-3 rounded-none px-3 py-3 text-sm text-black transition-colors duration-200 hover:bg-gray-100 dark:text-white dark:hover:bg-gray-700"
                      svg={() => <LinkIcon />}
                      text={localize('com_nav_help_faq')}
                      clickHandler={() => window.open(startupConfig?.helpAndFaqURL, '_blank')}
                    />
                  </Menu.Item>
                )}
                <Menu.Item as="div">
                  <NavLink
                    className="flex w-full cursor-pointer items-center gap-3 rounded-none px-3 py-3 text-sm text-black transition-colors duration-200 hover:bg-gray-100 dark:text-white dark:hover:bg-gray-700"
                    svg={() => <GearIcon className="icon-md" />}
                    text={localize('com_nav_settings')}
                    clickHandler={() => setShowSettings(true)}
                  />
                </Menu.Item>
                <div className="my-1 h-px bg-black/20 dark:bg-white/20" role="none" />
                <Menu.Item as="div">
                  <Logout />
                </Menu.Item>
              </Menu.Items>
            </Transition>
          </>
        )}
      </Menu>
      {showExports && (
        <ExportModal open={showExports} onOpenChange={setShowExports} conversation={conversation} />
      )}
      {showFiles && <FilesView open={showFiles} onOpenChange={setShowFiles} />}
      {showSettings && <Settings open={showSettings} onOpenChange={setShowSettings} />}
    </>
  );
}

export default memo(NavLinks);
