let isLocked = false;

export function lockCacheWrite(){
    isLocked = true;
}

export function unlockCacheWrite(){
    isLocked = false;
}

export function isCacheWriteLocked(): boolean{
    return isLocked;
}