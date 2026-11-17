import React, {createContext, useContext, useEffect, useState} from 'react';
import {ConfigProvider, Segmented, Button, Tooltip} from 'antd';
import {GlobalOutlined} from '@ant-design/icons';
import zhCN from 'antd/locale/zh_CN';
import enUS from 'antd/locale/en_US';
import type {Language, Translations} from './types';
import {zh} from './locales/zh';
import {en} from './locales/en';

interface I18nContextType {
  language: Language;
  setLanguage: (lang: Language) => void;
  toggleLanguage: () => void;
  t: Translations;
  isZh: boolean;
  isEn: boolean;
}

const STORAGE_KEY = 'spatialbridge_lang';

const translationsMap: Record<Language, Translations> = {
  zh,
  en,
};

const I18nContext = createContext<I18nContextType>({
  language: 'zh',
  setLanguage: () => {},
  toggleLanguage: () => {},
  t: zh,
  isZh: true,
  isEn: false,
});

export function LanguageProvider({children}: {children: React.ReactNode}) {
  const [language, setLanguageState] = useState<Language>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === 'en') return 'en';
      if (saved === 'zh') return 'zh';
    }
    // Default to Chinese as requested
    return 'zh';
  });

  const setLanguage = (lang: Language) => {
    setLanguageState(lang);
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem(STORAGE_KEY, lang);
      } catch {
        // localStorage might be unavailable in private browsing
      }
      document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';
    }
  };

  const toggleLanguage = () => {
    setLanguage(language === 'zh' ? 'en' : 'zh');
  };

  useEffect(() => {
    if (typeof window !== 'undefined') {
      document.documentElement.lang = language === 'en' ? 'en' : 'zh-CN';
    }
  }, [language]);

  const value: I18nContextType = {
    language,
    setLanguage,
    toggleLanguage,
    t: translationsMap[language],
    isZh: language === 'zh',
    isEn: language === 'en',
  };

  const antdLocale = language === 'en' ? enUS : zhCN;

  return (
    <I18nContext.Provider value={value}>
      <ConfigProvider locale={antdLocale}>
        {children}
      </ConfigProvider>
    </I18nContext.Provider>
  );
}

export function useI18n(): I18nContextType {
  return useContext(I18nContext);
}

export function LanguageSwitch({compact = false, className = ''}: {compact?: boolean; className?: string}) {
  const {language, setLanguage, toggleLanguage} = useI18n();

  if (compact) {
    return (
      <Tooltip title={language === 'zh' ? 'Switch to English' : '切换为中文'}>
        <Button
          size="small"
          type="text"
          className={`lang-switch-compact ${className}`}
          icon={<GlobalOutlined />}
          onClick={toggleLanguage}
          aria-label={language === 'zh' ? 'Switch to English' : '切换为中文'}
        >
          <span>{language === 'zh' ? 'EN' : '中'}</span>
        </Button>
      </Tooltip>
    );
  }

  return (
    <div className={`lang-switch-wrap ${className}`} role="group" aria-label="Language selection">
      <GlobalOutlined className="lang-icon" aria-hidden="true" />
      <Segmented
        size="small"
        value={language}
        onChange={(val) => setLanguage(val as Language)}
        options={[
          {label: '中文', value: 'zh'},
          {label: 'English', value: 'en'},
        ]}
      />
    </div>
  );
}
