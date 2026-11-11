import React from 'react';
import DraftPlayer from '../DraftPlayer';

export default function EditorShell({ children, overlay }) {
    return <div className="h-full min-h-0 flex flex-col">
        <div className="flex-1 min-h-0 flex gap-3 p-3">
            <section className="w-2/3 min-w-0 min-h-0 overflow-y-auto custom-scrollbar">{children}</section>
            <aside className="w-1/3 min-w-0 min-h-0 flex items-center justify-center"><div className="h-full max-h-full aspect-[9/16] max-w-full"><DraftPlayer overlay={overlay} /></div></aside>
        </div>
    </div>;
}
