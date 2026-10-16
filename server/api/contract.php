<?php
declare(strict_types=1);

// This file is an include only. If Apache does not honor .htaccess, do not
// serve an otherwise blank PHP response from a directly requested URL.
if (basename($_SERVER['SCRIPT_FILENAME'] ?? '') === 'contract.php') {
    http_response_code(404);
    exit;
}

function reader_valid_key(string $key): bool {
    return preg_match('/\A[a-f0-9]{64}\z/D', $key) === 1;
}

function reader_valid_book($book): bool {
    return is_string($book) && preg_match('/\A(?:txt|epub):[a-f0-9]{64}\z/D', $book) === 1;
}

function reader_valid_progress($value, string $book): bool {
    if (!is_array($value) || !reader_valid_book($book)) return false;
    $hash = substr($book, strpos($book, ':') + 1);
    if (($value['version'] ?? null) !== $hash) return false;
    foreach (['chapter', 'block'] as $field) {
        if (!isset($value[$field]) || !is_int($value[$field]) || $value[$field] < 0 || $value[$field] > 1000000) return false;
    }
    foreach (['fraction' => 1, 'percent' => 100] as $field => $max) {
        if (!isset($value[$field]) || !is_numeric($value[$field]) || is_string($value[$field]) || !is_finite((float)$value[$field]) || $value[$field] < 0 || $value[$field] > $max) return false;
    }
    return isset($value['updatedAt']) && is_int($value['updatedAt']) && $value['updatedAt'] >= 0 && $value['updatedAt'] <= 9007199254740991;
}

function reader_record($row): array {
    if (!$row) return ['revision' => 0, 'progress' => null];
    return ['revision' => (int)$row['revision'], 'progress' => json_decode($row['progress_json'], true)];
}
