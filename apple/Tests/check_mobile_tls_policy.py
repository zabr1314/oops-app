#!/usr/bin/env python3
"""Run the actual gateway's pure compatibility gate without app build or networking.

The Swift declaration is copied verbatim from MobileGateway.swift into a temporary
Foundation-only harness. No gateway instance, URLSession or credentials are created.
"""
from pathlib import Path
import subprocess
import tempfile


source = (Path(__file__).resolve().parents[1] / "Business/MobileGateway.swift").read_text()
policy = source[source.index("struct MobileConfiguration:"):source.index("final class MobileGateway {")]
harness = r'''
var checks = 0
func check(_ label: String, _ condition: @autoclosure () -> Bool) {
    precondition(condition(), label)
    checks += 1
}
let endpoint = "https://giftedprofessor.xyz/oops-meeting/apple-mobile"
let binding = MobileConfiguration(endpoint: endpoint, grantID: "test-grant", expiresAt: .distantFuture)
let ssl = NSError(domain: "kCFErrorDomainCFNetwork", code: -1200,
    userInfo: ["_kCFStreamErrorDomainKey": 3, "_kCFStreamErrorCodeKey": -9816])
let closed = NSError(domain: NSURLErrorDomain, code: -1200, userInfo: [NSUnderlyingErrorKey: ssl])
func permits(_ error: Error, method: String = "GET", path: String = "/capabilities") -> Bool {
    MobileTLSCompatibilityPolicy.permitsFallback(binding, method: method, path: path, error: error)
}
check("exact endpoint", MobileTLSCompatibilityPolicy.eligible(binding))
var explicitPort = binding
explicitPort.endpoint = "https://giftedprofessor.xyz:443/oops-meeting/apple-mobile"
check("explicit HTTPS port", MobileTLSCompatibilityPolicy.eligible(explicitPort))
for endpoint in ["http://giftedprofessor.xyz/oops-meeting/apple-mobile",
    "https://other.example/oops-meeting/apple-mobile",
    "https://sub.giftedprofessor.xyz/oops-meeting/apple-mobile",
    "https://giftedprofessor.xyz.example/oops-meeting/apple-mobile",
    "https://giftedprofessor.xyz:444/oops-meeting/apple-mobile",
    "https://giftedprofessor.xyz/oops-meeting/apple-mobile/",
    "https://giftedprofessor.xyz/oops-meeting/other",
    "https://giftedprofessor.xyz/oops-meeting%2Fapple-mobile",
    "https://giftedprofessor.xyz/oops-meeting/apple-mobile?q=1",
    "https://user@giftedprofessor.xyz/oops-meeting/apple-mobile"] {
    var other = binding; other.endpoint = endpoint
    check("reject other origin/path", !MobileTLSCompatibilityPolicy.eligible(other))
}
check("confirmed TLS failure", permits(closed))
check("POST never fallback", !permits(closed, method: "POST"))
check("PUT never fallback", !permits(closed, method: "PUT"))
check("other GET never fallback", !permits(closed, path: "/sessions"))
check("pair never fallback", !permits(closed, path: "/pair"))
check("query variant never fallback", !permits(closed, path: "/capabilities?q=1"))
for code in [-1202, -1001, -1003, -1005, -999] {
    check("other URL error stays failed", !permits(NSError(domain: NSURLErrorDomain, code: code,
        userInfo: [NSUnderlyingErrorKey: ssl])))
}
let invalidCauses: [[String: Any]] = [[:], ["_kCFStreamErrorDomainKey": 3, "_kCFStreamErrorCodeKey": -9807],
    ["_kCFStreamErrorDomainKey": 2, "_kCFStreamErrorCodeKey": -9816],
    ["_kCFStreamErrorDomainKey": "3", "_kCFStreamErrorCodeKey": "-9816"],
    ["_kCFStreamErrorDomainKey": 3.1, "_kCFStreamErrorCodeKey": -9816]]
for values in invalidCauses {
    check("exact SSL cause required", !permits(NSError(domain: NSURLErrorDomain, code: -1200, userInfo: values)))
}
let osClosed = NSError(domain: NSOSStatusErrorDomain, code: -9816)
check("typed SSL OSStatus", permits(NSError(domain: NSURLErrorDomain, code: -1200,
    userInfo: [NSUnderlyingErrorKey: osClosed])))
check("same binding reusable", MobileTLSCompatibilityPolicy.canReuse(binding, for: binding))
var changed = binding; changed.grantID = "replacement-grant"
check("grant replacement clears choice", !MobileTLSCompatibilityPolicy.canReuse(binding, for: changed))
changed = binding; changed.endpoint = "https://other.example/oops-meeting/apple-mobile"
check("endpoint replacement clears choice", !MobileTLSCompatibilityPolicy.canReuse(binding, for: changed))
changed = binding; changed.expiresAt = .distantPast
check("expired configuration clears choice", !MobileTLSCompatibilityPolicy.canReuse(binding, for: changed))
changed = binding; changed.expiresAt = Date().addingTimeInterval(60)
check("configuration replacement clears choice", !MobileTLSCompatibilityPolicy.canReuse(binding, for: changed))
check("no previous choice", !MobileTLSCompatibilityPolicy.canReuse(nil, for: binding))
let asr: [String: Any] = ["engine": "volc-bigmodel-async", "available": true, "version": 1, "max_chunk_ms": 32000]
check("compatible available body", MobileTLSCompatibilityPolicy.confirmsCapability(["asr": asr]))
let invalidCapabilities: [(String, Any)] = [("engine", "other"), ("available", false), ("version", 0), ("max_chunk_ms", 1000)]
for (key, value) in invalidCapabilities {
    var invalid = asr; invalid[key] = value
    check("bad capability does not select TLS12", !MobileTLSCompatibilityPolicy.confirmsCapability(["asr": invalid]))
}
print("Mobile TLS compatibility policy: \(checks) offline checks passed")
'''
with tempfile.TemporaryDirectory(prefix="oops-tls-policy-") as temporary:
    script = Path(temporary) / "PolicyChecks.swift"
    script.write_text("import Foundation\n" + policy + "\n" + harness)
    subprocess.run(["/usr/bin/swift", str(script)], check=True, timeout=90)
