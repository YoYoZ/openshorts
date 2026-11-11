import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

const WorkspaceContext = createContext(null);
const noop = () => {};
const EMPTY_WORKSPACE = { time: 0, timeRef: { current: 0 }, setTime: noop, subscribe: () => noop() };

export function WorkspaceProvider({ jobId, clipIndex, children }) {
    const timeRef = useRef(0);
    const listenersRef = useRef(new Set());
    const lastPublishedRef = useRef(0);
    const [time, setVisibleTime] = useState(0);

    const setTime = useCallback((next) => {
        const value = Math.max(0, Number(next) || 0);
        timeRef.current = value;
        const now = Date.now();
        if (now - lastPublishedRef.current >= 240) {
            lastPublishedRef.current = now;
            setVisibleTime(value);
            listenersRef.current.forEach((listener) => listener(value));
        }
    }, []);

    useEffect(() => {
        timeRef.current = 0;
        lastPublishedRef.current = 0;
        setVisibleTime(0);
        listenersRef.current.forEach((listener) => listener(0));
    }, [jobId, clipIndex]);

    const subscribe = useCallback((listener) => {
        listenersRef.current.add(listener);
        return () => listenersRef.current.delete(listener);
    }, []);

    return (
        <WorkspaceContext.Provider value={{ time, timeRef, setTime, subscribe }}>
            {children}
        </WorkspaceContext.Provider>
    );
}

// eslint-disable-next-line react-refresh/only-export-components -- the hook belongs with its provider
export function useWorkspace() {
    return useContext(WorkspaceContext) || EMPTY_WORKSPACE;
}
