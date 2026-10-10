# 被动监听串口（不拉 RTS/DTR，不复位板子）。用法: python listen.py COM4 [秒数]
import serial, sys, time

port = sys.argv[1]
secs = int(sys.argv[2]) if len(sys.argv) > 2 else 90

s = serial.Serial()
s.port = port
s.baudrate = 115200
s.dtr = False   # 打开前声明：不置位控制线，避免触发复位
s.rts = False
s.open()
end = time.time() + secs
buf = b''
while time.time() < end:
    n = s.in_waiting
    if n:
        buf += s.read(n)
    else:
        time.sleep(0.1)
s.close()
sys.stdout.write(buf.decode('utf-8', 'replace'))
