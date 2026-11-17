import React from 'react';
import {ArrowLeftOutlined} from '@ant-design/icons';
import {Tooltip} from 'antd';
import {TranslatedText, LanguageSwitch, useI18n} from '../i18n';
import './AppHeader.css';

export interface AppHeaderStatus {
  label: string;
  tone: 'processing' | 'queued' | 'error' | 'warning';
}

export interface AppHeaderProps {
  onHome?: () => void;
  tagline?: string;
  projectTitle?: string;
  projectTooltip?: string;
  status?: AppHeaderStatus;
  center?: React.ReactNode;
  actions?: React.ReactNode;
  mobileActions?: React.ReactNode;
  sticky?: boolean;
  className?: string;
}

export function AppHeader({
  onHome,
  tagline,
  projectTitle,
  projectTooltip,
  status,
  center,
  actions,
  mobileActions,
  sticky = false,
  className = '',
}: AppHeaderProps) {
  const {t} = useI18n();
  const hasActions = Boolean(actions);
  const headerClass = [
    'app-header',
    sticky ? 'app-header--sticky' : '',
    center ? 'app-header--with-center' : '',
    className,
  ].filter(Boolean).join(' ');

  return (
    <header className={headerClass}>
      <div className="app-header__left">
        {onHome ? (
          <Tooltip title={<TranslatedText text={t.common.backHome} />} placement="bottomLeft">
            <button
              type="button"
              className="app-brand app-brand--link"
              onClick={onHome}
              aria-label={t.common.backHome}
            >
              <span className="app-brand__back" aria-hidden="true">
                <ArrowLeftOutlined />
              </span>
              <span className="app-brand__mark" aria-hidden="true">
                <img src="/spatialbridge-logo.png" alt="" />
              </span>
              <span className="app-brand__name">SpatialBridge</span>
            </button>
          </Tooltip>
        ) : (
          <div className="app-brand">
            <span className="app-brand__mark" aria-hidden="true">
              <img src="/spatialbridge-logo.png" alt="" />
            </span>
            <span className="app-brand__name">SpatialBridge</span>
          </div>
        )}

        {!projectTitle && tagline && (
          <>
            <span className="app-header__sep" aria-hidden="true" />
            <span className="app-header__tagline">
              <TranslatedText text={tagline} />
            </span>
          </>
        )}

        {projectTitle && (
          <div className="app-breadcrumb">
            <span className="app-breadcrumb__slash" aria-hidden="true">/</span>
            <Tooltip title={projectTooltip || projectTitle} placement="bottomLeft">
              <span className="app-breadcrumb__project">
                <TranslatedText text={projectTitle} />
              </span>
            </Tooltip>
            {status && (
              <span className={`app-header__status app-header__status--${status.tone}`}>
                <span className="app-header__status-dot" aria-hidden="true" />
                <TranslatedText text={status.label} />
              </span>
            )}
          </div>
        )}
      </div>

      {center && <div className="app-header__center">{center}</div>}

      <div className="app-header__right">
        {actions && <div className="app-header__actions">{actions}</div>}
        {hasActions && <span className="app-header__divider" aria-hidden="true" />}
        <div className="app-header__lang">
          <LanguageSwitch compact />
        </div>
        {mobileActions}
      </div>
    </header>
  );
}
