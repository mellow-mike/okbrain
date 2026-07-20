# Homebrew formula template for a tap (e.g. <owner>/homebrew-okb).
# Fill VERSION and the per-platform SHA256 values from the release's
# SHA256SUMS.txt, then `brew install <owner>/okb/okb`.
#
# okb looks for vec0 next to its own executable, so both land in libexec and
# bin gets a symlink — the symlink resolves to libexec/okb at runtime.
class Okb < Formula
  desc "OKF-native personal knowledge manager (single binary)"
  homepage "https://github.com/mellow-mike/okbrain"
  version "VERSION"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/mellow-mike/okbrain/releases/download/v#{version}/okb-#{version}-darwin-arm64.tar.gz"
      sha256 "SHA256_DARWIN_ARM64"
    end
    on_intel do
      url "https://github.com/mellow-mike/okbrain/releases/download/v#{version}/okb-#{version}-darwin-x64.tar.gz"
      sha256 "SHA256_DARWIN_X64"
    end
  end
  on_linux do
    on_arm do
      url "https://github.com/mellow-mike/okbrain/releases/download/v#{version}/okb-#{version}-linux-arm64.tar.gz"
      sha256 "SHA256_LINUX_ARM64"
    end
    on_intel do
      url "https://github.com/mellow-mike/okbrain/releases/download/v#{version}/okb-#{version}-linux-x64.tar.gz"
      sha256 "SHA256_LINUX_X64"
    end
  end

  def install
    vec = OS.mac? ? "vec0.dylib" : "vec0.so"
    libexec.install "okb", vec
    bin.install_symlink libexec/"okb"
  end

  test do
    assert_match "okb", shell_output("#{bin}/okb help")
  end
end
