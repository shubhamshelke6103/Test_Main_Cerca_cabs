const fs = require('fs');
const path = require('path');

const DRIVER_PROFILE_PIC_SUBDIR = 'uploads/driverProfilePics';

const ALLOWED_PROFILE_PIC_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

const isAllowedProfilePicMime = (mimetype) =>
    typeof mimetype === 'string' && ALLOWED_PROFILE_PIC_MIMES.has(mimetype);

const buildDriverProfilePicUrl = (req, file) => {
    if (!file || !file.filename) return null;
    return `${req.protocol}://${req.get('host')}/${DRIVER_PROFILE_PIC_SUBDIR}/${file.filename}`;
};

const resolveStoredDriverProfilePicPath = (profilePicUrl) => {
    if (typeof profilePicUrl !== 'string' || !profilePicUrl.trim()) return null;
    const trimmed = profilePicUrl.trim();
    if (/^https?:\/\//i.test(trimmed)) {
        try {
            const pathname = new URL(trimmed).pathname.replace(/^\/+/, '');
            if (!pathname.includes('..') && pathname.startsWith(`${DRIVER_PROFILE_PIC_SUBDIR}/`)) {
                return path.resolve(process.cwd(), pathname);
            }
        } catch {
            return null;
        }
        return null;
    }
    const base = path.basename(trimmed);
    if (!base || base.includes('..')) return null;
    return path.resolve(process.cwd(), DRIVER_PROFILE_PIC_SUBDIR, base);
};

const unlinkDriverProfilePicFile = (profilePicUrl) => {
    const absolutePath = resolveStoredDriverProfilePicPath(profilePicUrl);
    if (!absolutePath || !fs.existsSync(absolutePath)) return;
    try {
        fs.unlinkSync(absolutePath);
    } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('Failed to delete driver profile pic:', err?.message);
    }
};

module.exports = {
    DRIVER_PROFILE_PIC_SUBDIR,
    ALLOWED_PROFILE_PIC_MIMES,
    isAllowedProfilePicMime,
    buildDriverProfilePicUrl,
    unlinkDriverProfilePicFile,
};
