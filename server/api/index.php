<?php
declare(strict_types=1);
require_once __DIR__ . '/contract.php';
ini_set('display_errors', '0');
ini_set('log_errors', '0');

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: no-referrer');

function respond(int $status, array $body): void {
    http_response_code($status);
    echo json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    header('Allow: POST'); respond(405, ['message' => '请使用 POST 请求']);
}
if (stripos($_SERVER['CONTENT_TYPE'] ?? '', 'application/json') !== 0) respond(415, ['message' => '请求格式必须为 JSON']);
if ((int)($_SERVER['CONTENT_LENGTH'] ?? 0) > 8192) respond(413, ['message' => '请求过大']);
$raw = file_get_contents('php://input', false, null, 0, 8193);
if ($raw === false || strlen($raw) > 8192) respond(413, ['message' => '请求过大']);
$body = json_decode($raw, true);
if (!is_array($body)) respond(400, ['message' => 'JSON 无效']);
$action = $body['action'] ?? '';
if (!in_array($action, ['create', 'connect', 'get', 'put', 'erase'], true)) respond(400, ['message' => '未知操作']);
$authorization = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
$key = preg_match('/\ABearer ([a-f0-9]{64})\z/D', $authorization, $match) === 1 ? $match[1] : '';
if (!reader_valid_key($key)) respond(401, ['message' => '同步密钥无效']);
$profile = hash('sha256', $key);
unset($key, $authorization, $match);

try {
    // Support both local project layout and DirectAdmin's public_html sibling:
    //   project/reader-private/config.php
    //   public_html/../reader-private/config.php
    // Never fall back to a public URL or a file shipped in dist/.
    $configCandidates = [];
    if (getenv('READER_CONFIG_FILE')) $configCandidates[] = getenv('READER_CONFIG_FILE');
    $configCandidates[] = dirname(__DIR__, 3) . '/reader-private/config.php';
    $configCandidates[] = dirname(__DIR__, 2) . '/reader-private/config.php';
    $configPath = null;
    foreach (array_unique($configCandidates) as $candidate) {
        if (is_string($candidate) && is_file($candidate)) { $configPath = $candidate; break; }
    }
    if ($configPath === null) respond(503, ['message' => '线上同步尚未配置，阅读进度仍保存在本机']);
    $config = require $configPath;
    if (!is_array($config) || !preg_match('/\A[a-f0-9]{64}\z/D', $config['rate_secret'] ?? '')) respond(503, ['message' => '线上同步配置不完整']);
    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    if ($origin !== '' && $origin !== $config['origin']) respond(403, ['message' => '不允许此来源访问同步接口']);
    $address = !empty($config['socket']) ? 'unix_socket=' . $config['socket'] : 'host=' . $config['host'];
    $pdo = new PDO('mysql:' . $address . ';dbname=' . $config['database'] . ';charset=utf8mb4', $config['username'], $config['password'], [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
    ]);
    // HMAC of the actual peer IP, not an untrusted X-Forwarded-For header.
    function limit_request(PDO $pdo, string $identity, int $window, int $maximum, string $secret): void {
        $now = time();
        $bucket = hash_hmac('sha256', $identity . ':' . intdiv($now, $window), $secret);
        $pdo->beginTransaction();
        $statement = $pdo->prepare('INSERT INTO reader_limits (bucket_key, hits, expires_at) VALUES (?, 1, ?) ON DUPLICATE KEY UPDATE hits = hits + 1');
        $statement->execute([$bucket, $now + $window * 2]);
        $statement = $pdo->prepare('SELECT hits FROM reader_limits WHERE bucket_key = ? FOR UPDATE');
        $statement->execute([$bucket]);
        $hits = (int)$statement->fetchColumn();
        $pdo->commit();
        if ($hits > $maximum) { header('Retry-After: ' . $window); respond(429, ['message' => '同步请求过于频繁，请稍后再试']); }
    }
    $peer = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
    limit_request($pdo, 'ip:' . $peer, 600, 600, $config['rate_secret']);
    if ($action === 'create') limit_request($pdo, 'create:' . $peer, 3600, 10, $config['rate_secret']);
    $pdo->exec('DELETE FROM reader_limits WHERE expires_at < UNIX_TIMESTAMP() LIMIT 100');

    if ($action === 'create') {
        $statement = $pdo->prepare('INSERT IGNORE INTO reader_profiles (key_hash) VALUES (?)');
        $statement->execute([$profile]);
        $statement = $pdo->prepare('SELECT revoked FROM reader_profiles WHERE key_hash = ?');
        $statement->execute([$profile]);
        if ((int)$statement->fetchColumn() !== 0) respond(401, ['message' => '此密钥已作废，请创建新密钥']);
        respond(200, ['ok' => true]);
    }
    $statement = $pdo->prepare('SELECT key_hash FROM reader_profiles WHERE key_hash = ? AND revoked = 0');
    $statement->execute([$profile]);
    if (!$statement->fetch()) respond(401, ['message' => '同步密钥不存在或已删除']);
    if ($action === 'connect') respond(200, ['ok' => true]);
    if ($action === 'erase') {
        $pdo->beginTransaction();
        $statement = $pdo->prepare('UPDATE reader_profiles SET revoked = 1 WHERE key_hash = ?');
        $statement->execute([$profile]);
        $statement = $pdo->prepare('DELETE FROM reader_progress WHERE profile_hash = ?');
        $statement->execute([$profile]);
        $pdo->commit();
        respond(200, ['ok' => true]);
    }
    $book = $body['book'] ?? null;
    if (!reader_valid_book($book)) respond(400, ['message' => '书籍指纹无效']);
    if ($action === 'get') {
        $statement = $pdo->prepare('SELECT revision, progress_json FROM reader_progress WHERE profile_hash = ? AND book_key = ?');
        $statement->execute([$profile, $book]);
        respond(200, ['record' => reader_record($statement->fetch())]);
    }
    $revision = $body['revision'] ?? null;
    $progress = $body['progress'] ?? null;
    if (!is_int($revision) || $revision < 0 || $revision > 2147483646 || !reader_valid_progress($progress, $book)) respond(400, ['message' => '阅读位置或版本号无效']);
    // Store only the contract fields, never arbitrary client text or metadata.
    $progress = array_intersect_key($progress, array_flip(['version', 'chapter', 'block', 'fraction', 'percent', 'updatedAt']));
    // Lock the profile to serialize initial inserts and quota checks as well as updates.
    $pdo->beginTransaction();
    $statement = $pdo->prepare('SELECT key_hash FROM reader_profiles WHERE key_hash = ? AND revoked = 0 FOR UPDATE');
    $statement->execute([$profile]);
    if (!$statement->fetch()) { $pdo->rollBack(); respond(401, ['message' => '同步密钥已删除']); }
    $statement = $pdo->prepare('SELECT revision, progress_json FROM reader_progress WHERE profile_hash = ? AND book_key = ? FOR UPDATE');
    $statement->execute([$profile, $book]);
    $existing = reader_record($statement->fetch());
    if ($existing['revision'] !== $revision) {
        $pdo->rollBack(); respond(409, ['message' => '另一设备更新了进度', 'record' => $existing]);
    }
    if ($revision === 0) {
        $statement = $pdo->prepare('SELECT COUNT(*) FROM reader_progress WHERE profile_hash = ?');
        $statement->execute([$profile]);
        if ((int)$statement->fetchColumn() >= 1000) { $pdo->rollBack(); respond(422, ['message' => '当前密钥的书籍进度已达到 1000 本上限']); }
        $statement = $pdo->prepare('INSERT INTO reader_progress (profile_hash, book_key, revision, progress_json) VALUES (?, ?, 1, ?)');
        $statement->execute([$profile, $book, json_encode($progress)]);
    } else {
        $statement = $pdo->prepare('UPDATE reader_progress SET revision = revision + 1, progress_json = ? WHERE profile_hash = ? AND book_key = ?');
        $statement->execute([json_encode($progress), $profile, $book]);
    }
    $pdo->commit();
    respond(200, ['record' => ['revision' => $revision + 1, 'progress' => $progress]]);
} catch (Throwable $error) {
    if (isset($pdo) && $pdo->inTransaction()) $pdo->rollBack();
    // No PDO messages, passwords, request bodies or bearer keys in responses/logs.
    respond(503, ['message' => '同步服务暂不可用，本机进度仍会保留']);
}
