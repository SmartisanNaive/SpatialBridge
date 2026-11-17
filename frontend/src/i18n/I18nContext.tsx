import React, {createContext, useContext, useEffect, useLayoutEffect, useRef, useState} from 'react';
import {animate, motion, useMotionValue, useReducedMotion, useTransform} from 'motion/react';
import {ConfigProvider} from 'antd';
import './LanguageSwitch.css';
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
  const {language, toggleLanguage} = useI18n();
  const reduce = useReducedMotion();
  const zhRef = useRef<HTMLSpanElement>(null);
  const enRef = useRef<HTMLSpanElement>(null);
  const pointer = useRef(false);
  const [swing, setSwing] = useState(0);
  const english = language === 'en';
  const progress = useMotionValue(english ? 1 : 0);
  const zhWidth = useMotionValue(0);
  const enWidth = useMotionValue(0);
  const width = useTransform([progress, zhWidth, enWidth], ([t, zh, en]: number[]) => zh + (en - zh) * t);
  const zhOpacity = useTransform(progress, [0, 1], [1, 0]);
  const enOpacity = useTransform(progress, [0, 1], [0, 1]);
  const zhY = useTransform(progress, [0, 1], [0, -6]);
  const enY = useTransform(progress, [0, 1], [6, 0]);

  useLayoutEffect(() => {
    let active = true;
    const measure = () => {
      if (!active) return;
      zhWidth.set(zhRef.current?.offsetWidth ?? 0);
      enWidth.set(enRef.current?.offsetWidth ?? 0);
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (zhRef.current) observer.observe(zhRef.current);
    if (enRef.current) observer.observe(enRef.current);
    void document.fonts.ready.then(measure);
    return () => { active = false; observer.disconnect(); };
  }, [compact, zhWidth, enWidth]);

  useLayoutEffect(() => {
    const shouldAnimate = pointer.current && !reduce;
    pointer.current = false;
    if (!shouldAnimate) {
      progress.jump(english ? 1 : 0);
      return;
    }
    setSwing((value) => value + 1);
    const controls = animate(progress, english ? 1 : 0, {type: 'spring', duration: 0.3, bounce: 0});
    return () => controls.stop();
  }, [english, reduce, progress]);

  const actionLabel = english ? '切换为中文' : 'Switch to English';
  return (
    <motion.button
      type="button"
      className={`language-toggle${compact ? ' language-toggle--compact' : ''}${className ? ` ${className}` : ''}`}
      data-on={english}
      aria-pressed={english}
      aria-label={english ? 'English，切换为中文' : '中文, Switch to English'}
      title={actionLabel}
      onPointerDown={() => { pointer.current = true; }}
      onKeyDown={() => { pointer.current = false; }}
      onClick={toggleLanguage}
      whileTap={reduce ? undefined : {scale: 0.96}}
    >
      <motion.span
        key={swing}
        className="language-toggle__icon"
        aria-hidden="true"
        animate={swing && !reduce ? {rotate: [0, -17, 12, -7, 3, 0]} : {rotate: 0}}
        transition={{duration: 0.65, ease: 'easeInOut'}}
      ><GlobalOutlined /></motion.span>
      <motion.span className="language-toggle__labels" style={{width}} aria-hidden="true">
        <motion.span ref={zhRef} className="language-toggle__label" lang="zh-CN" style={{opacity: zhOpacity, y: zhY}}>中文</motion.span>
        <motion.span ref={enRef} className="language-toggle__label" lang="en" style={{opacity: enOpacity, y: enY}}>English</motion.span>
      </motion.span>
    </motion.button>
  );
}
