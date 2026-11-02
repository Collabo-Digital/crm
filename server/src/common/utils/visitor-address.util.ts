import { ipv6Groups } from '../../automation/engine/http-request';

/**
 * The address a public request is counted under for a limit per visitor: the
 * IPv4 address, or the /64 of an IPv6 one, since a connection is usually
 * given a whole /64 and could otherwise use a new address for every request.
 */
export function visitorAddress(ip: string | undefined): string {
    const groups = ipv6Groups(ip ?? '');
    if (!groups) return ip || 'unknown';
    if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
        return `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
    }
    return `${groups.slice(0, 4).map((g) => g.toString(16)).join(':')}::/64`;
}
