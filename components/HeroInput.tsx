"use client";

import { useState, KeyboardEvent, useEffect, useRef } from "react";

interface HeroInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder?: string;
  className?: string;
  showSearchFeatures?: boolean;
}

function isURL(str: string): boolean {
  // Check if string contains a dot and looks like a URL
  const urlPattern = /^(https?:\/\/)?([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(\/.*)?$/;
  return urlPattern.test(str.trim());
}

export default function HeroInput({ 
  value, 
  onChange, 
  onSubmit, 
  placeholder = "Describe what you want to build...",
  className = "",
  showSearchFeatures = true
}: HeroInputProps) {
  const [isFocused, setIsFocused] = useState(false);
  const [showTiles, setShowTiles] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isURLInput = showSearchFeatures ? isURL(value) : false;

  // Reset textarea height when value changes (especially when cleared)
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = textareaRef.current.scrollHeight + 'px';
    }
    
    // Show tiles animation for search terms (only if search features are enabled)
    if (showSearchFeatures && value.trim() && !isURL(value) && isFocused) {
      setShowTiles(true);
    } else {
      setShowTiles(false);
    }
  }, [value, isFocused, showSearchFeatures]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSubmit();
    }
  };

  return (
    <div className={`max-w-552 mx-auto w-full relative z-[11] rounded-20 ${className}`}>
      <div
        className=""
      />

      <div className="relative">
        <label className="flex w-full items-start gap-8 p-16">
          {showSearchFeatures && (
          <div className="mt-2 flex-shrink-0">
            {isURLInput ? (
              <svg
                width="20"
                height="20"
                viewBox="0 0 20 20"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                className="opacity-40"
              >
                <path d="M9 11L11 9M11 9L15 5M11 9L5 15M15 5L13 3M15 5L17 7" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M7 13L5 15L3 13" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M13 7L15 5L17 7" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            ) : (
              <svg
                width="20"
                height="20"
                viewBox="0 0 20 20"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                className="opacity-40"
              >
                <circle cx="8.5" cy="8.5" r="5.5" stroke="currentColor" strokeWidth="1.5"/>
                <path d="M12.5 12.5L16.5 16.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            )}
          </div>
          )}

          <textarea
            ref={textareaRef}
            className="min-h-[24px] w-full min-w-0 flex-1 resize-none bg-transparent text-body-input leading-6 text-accent-black outline-none placeholder:text-black-alpha-48"
            placeholder={placeholder}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            rows={1}
            style={{
              height: 'auto',
              overflow: 'hidden'
            }}
            onInput={(e) => {
              const target = e.target as HTMLTextAreaElement;
              target.style.height = 'auto';
              target.style.height = target.scrollHeight + 'px';
            }}
          />
          <button
            type="button"
            onClick={onSubmit}
            disabled={!value.trim()}
            aria-label="Send"
            className={`
              button relative mt-[-4px] flex h-[32px] w-[32px] shrink-0 items-center justify-center rounded-10 px-8 py-8 text-label-medium font-medium
              ${value.trim()
                ? 'button-primary text-accent-white active:scale-[0.995]'
                : 'cursor-not-allowed bg-black-alpha-4 text-black-alpha-24'
              }
            `}
          >
            {value.trim() && <div className="button-background pointer-events-none absolute inset-0 rounded-10" />}
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <path d="M3 8H13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M8.5 3.5L13 8L8.5 12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        </label>
      </div>

      {/* Animated tiles for search results */}
      {showTiles && (
        <div className="mt-16 grid grid-cols-3 gap-12 px-16">
          {[0, 1, 2].map((index) => (
            <div
              key={index}
              className="tile-animation relative aspect-[4/3] bg-black-alpha-4 rounded-12 overflow-hidden"
              style={{
                animationDelay: `${index * 100}ms`
              }}
            >
              <div className="absolute inset-0 bg-gradient-to-br from-black-alpha-4 to-transparent" />
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="w-8 h-8 bg-black-alpha-8 rounded-full animate-pulse" />
              </div>
            </div>
          ))}
        </div>
      )}

      <style jsx>{`
        @keyframes tileSlideUp {
          from {
            opacity: 0;
            transform: translateY(20px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        .tile-animation {
          animation: tileSlideUp 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards;
          opacity: 0;
        }
      `}</style>
    </div>
  );
}