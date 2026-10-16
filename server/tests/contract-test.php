<?php
declare(strict_types=1);
require __DIR__ . '/../api/contract.php';

function check(bool $value, string $message): void {
    if (!$value) throw new RuntimeException($message);
}
$hash = str_repeat('a', 64);
$progress = ['version' => $hash, 'chapter' => 12, 'block' => 3, 'fraction' => 0.5, 'percent' => 20.4, 'updatedAt' => 1790000000000];
check(reader_valid_key($hash), 'valid key');
check(!reader_valid_key('../secret'), 'reject malformed key');
check(reader_valid_book('epub:' . $hash), 'valid book');
check(!reader_valid_book('https://example.com/book.epub'), 'no arbitrary book identifiers');
check(reader_valid_progress($progress, 'epub:' . $hash), 'valid progress');
check(!reader_valid_progress(array_merge($progress, ['version' => 'changed']), 'epub:' . $hash), 'reject changed edition');
check(!reader_valid_progress(array_merge($progress, ['chapter' => -1]), 'epub:' . $hash), 'reject negative chapter');
check(!reader_valid_progress(array_merge($progress, ['fraction' => INF]), 'epub:' . $hash), 'reject infinite fraction');
check(!reader_valid_progress(array_merge($progress, ['fraction' => '0.5']), 'epub:' . $hash), 'reject string fraction');
check(!reader_valid_progress(array_merge($progress, ['percent' => 101]), 'epub:' . $hash), 'reject percent');
check(reader_record(false) === ['revision' => 0, 'progress' => null], 'empty record');
check(reader_record(['revision' => '2', 'progress_json' => json_encode($progress)])['revision'] === 2, 'revision normalization');
echo "PHP 契约测试通过（12 项断言，无数据库访问）\n";
