/** Only generates our original sample EPUB. Never overwrites the user's catalog. */
import fs from 'node:fs/promises';
import { zipSync, strToU8 } from 'fflate';

const chapters = [
  ['第一章 一封未寄的信', [
    '桌上的信已经放了三天。许宁每天从它旁边经过，都想着等天气好一些就出门。信封上没有写地址，只有一个用铅笔画的小小太阳。',
    '她在靠窗的地方坐下来，把信纸重新铺开。纸角被杯子压出了一点浅浅的圆痕，字迹却很清楚。那是一个没有什么特别事情发生的下午，楼下有人推着自行车走过，车铃轻轻响了一声。',
    '信里写了一条她最近发现的小路。沿着河往南，经过两棵很高的树，就会遇见一家不挂招牌的书店。她去了两次，第一次是为了躲雨，第二次是想把一本没看完的书读完。',
    '她原本打算把这些都说得简短一些，写着写着却添了很多无关紧要的细节。比如窗台上的植物长出了一片新叶，比如书店里的钟比手机慢了两分钟，又比如那天下午的雨很小。',
    '这些小事放在信纸上，竟然很合适。它们不需要一个结论，也不急着告诉谁应该怎么做。她把最后一行写完，留下一点空白，准备明天再看一次。',
    '门外响起钥匙转动的声音。许宁把信放回桌上，起身去烧水。窗外的雨还没有停，热气慢慢升起来，把玻璃映得有些模糊。',
    '等水烧开时，她忽然想到，信也不一定要等晴天再寄。雨天的路只是走起来慢一点，并不是不能走。她在信封上补好地址，把它装进了明天出门用的帆布袋。',
  ]],
  ['第二章 晴天再见', [
    '雨终于停了。许宁把信放进口袋，决定不再等一个更合适的下午。窗边那盆很久没有开花的植物，恰好在今天长出了新的叶子。',
    '邮筒离家不远，中间经过一家卖面包的小店。她停下来买了两个，纸袋很暖。街道被雨洗过，连那些平时看不见的墙角，都清清楚楚地露了出来。',
    '信落进邮筒时发出很轻的一声。她在原地站了片刻，没有拿出手机查看什么，只沿着树影往前走。这条路以前也走过，但今天不太一样。',
    '走到河边时，阳光从云后面出来了。她坐在长椅上吃完一个面包，把另一个留着。河对面的书店还没有开门，窗帘后面透出一小块暖色的光。',
    '她想，等收到回信的时候，也许天气又会改变。不过没关系，这些事可以慢慢说。她还有下一张信纸，和一个没有排满的下午。',
  ]],
];
const escape = value => value.replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch]);
const files = {
  mimetype: [strToU8('application/epub+zip'), { level: 0 }],
  'META-INF/container.xml': strToU8('<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
  'EPUB/package.opf': strToU8(`<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">paper-reader-original-rain-letter</dc:identifier><dc:title>雨天来信</dc:title><dc:language>zh-CN</dc:language><dc:creator>纸间示例</dc:creator><meta property="dcterms:modified">2026-10-16T00:00:00Z</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${chapters.map((_, i) => `<item id="c${i}" href="text/ch${i}.xhtml" media-type="application/xhtml+xml"/>`).join('')}</manifest><spine>${chapters.map((_, i) => `<itemref idref="c${i}"/>`).join('')}</spine></package>`),
  'EPUB/nav.xhtml': strToU8(`<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><ol>${chapters.map(([title], i) => `<li><a href="text/ch${i}.xhtml">${escape(title)}</a></li>`).join('')}</ol></nav></body></html>`),
};
chapters.forEach(([title, paragraphs], i) => {
  files[`EPUB/text/ch${i}.xhtml`] = strToU8(`<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${escape(title)}</title></head><body><h1>${escape(title)}</h1>${paragraphs.map(p => `<p>${escape(p)}</p>`).join('')}</body></html>`);
});
await fs.mkdir(new URL('../public/books/samples/', import.meta.url), { recursive: true });
await fs.writeFile(new URL('../public/books/samples/rain-letter.epub', import.meta.url), zipSync(files));
console.log('已生成原创示例 rain-letter.epub');
